// Web Serial reader for barcode/RFID scanners in USB serial (CDC-ACM) mode.
//
// Needs Firefox 151+ or Chromium 89+ and a secure context (https, or http://localhost).
// The first requestPort() must run from a user tap; after that start() reopens the
// remembered scanner on page load and whenever it is plugged back in.
//
//   import { WebSerialScanner } from './webserial-scanner.js';
//   const scanner = new WebSerialScanner({ filters: [{ usbVendorId: 0x1234 }] });
//   scanner.addEventListener('scan', (e) => handleScan(e.detail.value));
//   scanner.start();
//   connectButton.addEventListener('click', () => scanner.requestPort());
//
// Events (CustomEvent, payload in event.detail):
//   scan          { value, receivedAt }
//   rejected      { reason: 'too-long' | 'invalid-encoding' | 'invalid-characters' | 'duplicate', length }
//   connected     { usbVendorId, usbProductId }
//   disconnected  { reason: 'stopped' | 'lost' }
//   error         { stage: 'request' | 'open' | 'read' | 'close' | 'reconnect', error }
//
// Scan values are validated but still untrusted: write them to the DOM with textContent
// and into URLs with encodeURIComponent.

const SERIAL_KEYS = ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl', 'bufferSize'];
const MAX_BUFFER_SIZE = 16777216;
const MAX_RECONNECT_DELAY = 30000;

const DEFAULTS = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    bufferSize: 255,

    // USB ids allowed in the port picker and for auto-reconnect, empty = any
    filters: [],
    terminators: [0x0d, 0x0a],
    // ms of silence that also ends a scan, for scanners set to send no suffix; 0 disables
    idleTimeout: 300,
    // bytes; longer frames are dropped, never buffered
    maxLength: 512,
    // blocks control, format (bidi overrides, zero-width), private-use and unassigned characters
    allowedPattern: /^[^\p{C}\p{Zl}\p{Zp}]+$/u,
    trim: true,
    // ms; the same value again inside this window is treated as a double read
    duplicateWindow: 500,
    // localStorage key for the remembered device, null to disable
    storageKey: 'webserial-scanner.device',
    reconnectDelay: 1000,
    // 0 disables automatic reconnects
    reconnectAttempts: 5,
};

function isUint16(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function isCount(value, min) {
    return Number.isInteger(value) && value >= min;
}

function isFilter(filter) {
    return filter !== null && typeof filter === 'object'
        && isUint16(filter.usbVendorId)
        && (filter.usbProductId === undefined || isUint16(filter.usbProductId));
}

function assertOption(ok, name, expected) {
    if (!ok) {
        throw new TypeError(`WebSerialScanner: ${name} must be ${expected}`);
    }
}

function normalizeOptions(options) {
    const o = { ...DEFAULTS, ...options };
    assertOption(isCount(o.baudRate, 1), 'baudRate', 'a positive integer');
    assertOption(o.dataBits === 7 || o.dataBits === 8, 'dataBits', '7 or 8');
    assertOption(o.stopBits === 1 || o.stopBits === 2, 'stopBits', '1 or 2');
    assertOption(['none', 'even', 'odd'].includes(o.parity), 'parity', "'none', 'even' or 'odd'");
    assertOption(['none', 'hardware'].includes(o.flowControl), 'flowControl', "'none' or 'hardware'");
    assertOption(isCount(o.bufferSize, 1) && o.bufferSize <= MAX_BUFFER_SIZE, 'bufferSize', `an integer from 1 to ${MAX_BUFFER_SIZE}`);
    assertOption(Array.isArray(o.filters) && o.filters.every(isFilter), 'filters', 'an array of { usbVendorId, usbProductId? } with 16-bit ids');
    assertOption(Array.isArray(o.terminators) && o.terminators.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff), 'terminators', 'an array of byte values (0-255)');
    assertOption(isCount(o.idleTimeout, 0), 'idleTimeout', 'a non-negative integer (ms)');
    assertOption(isCount(o.maxLength, 1), 'maxLength', 'a positive integer (bytes)');
    assertOption(o.allowedPattern instanceof RegExp, 'allowedPattern', 'a RegExp');
    assertOption(typeof o.trim === 'boolean', 'trim', 'a boolean');
    assertOption(isCount(o.duplicateWindow, 0), 'duplicateWindow', 'a non-negative integer (ms)');
    assertOption(o.storageKey === null || (typeof o.storageKey === 'string' && o.storageKey !== ''), 'storageKey', 'a non-empty string or null');
    assertOption(isCount(o.reconnectDelay, 1), 'reconnectDelay', 'a positive integer (ms)');
    assertOption(isCount(o.reconnectAttempts, 0), 'reconnectAttempts', 'a non-negative integer');

    return Object.freeze({
        serial: Object.fromEntries(SERIAL_KEYS.map((key) => [key, o[key]])),
        filters: o.filters.map(({ usbVendorId, usbProductId }) =>
            (usbProductId === undefined ? { usbVendorId } : { usbVendorId, usbProductId })),
        terminators: new Set(o.terminators),
        idleTimeout: o.idleTimeout,
        maxLength: o.maxLength,
        // g and y make test() stateful through lastIndex, which would fail every other scan
        allowedPattern: new RegExp(o.allowedPattern.source, o.allowedPattern.flags.replace(/[gy]/g, '')),
        trim: o.trim,
        duplicateWindow: o.duplicateWindow,
        storageKey: o.storageKey,
        reconnectDelay: o.reconnectDelay,
        reconnectAttempts: o.reconnectAttempts,
    });
}

function portIds(port) {
    const { usbVendorId = null, usbProductId = null } = port.getInfo();
    return { usbVendorId, usbProductId };
}

function sameDevice(a, b) {
    return a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
}

function matchesFilters(ids, filters) {
    return filters.some((f) => f.usbVendorId === ids.usbVendorId
        && (f.usbProductId === undefined || f.usbProductId === ids.usbProductId));
}

export class WebSerialUnavailableError extends Error {
    constructor(reason) {
        super(reason === 'insecure-context'
            ? 'Web Serial needs a secure context: serve the page over https or open it from localhost'
            : 'Web Serial is not available: it needs Firefox 151+ or Chromium 89+ and can be disabled by browser policy');
        this.name = 'WebSerialUnavailableError';
        this.reason = reason;
    }
}

export class WebSerialScanner extends EventTarget {
    #options;
    #decoder = new TextDecoder('utf-8', { fatal: true });

    #running = false;
    #opening = false;
    #closing = null;
    #port = null;
    #reader = null;
    #reading = null;
    #reconnectTimer = null;
    #reconnectCount = 0;

    #frame;
    #frameLength = 0;
    #idleTimer = null;
    #lastValue = null;
    #lastTime = 0;

    #onConnect = () => this.#handleConnect();
    #onDisconnect = (event) => this.#handleDisconnect(event);
    #onPageHide = () => this.#handlePageHide();
    #onPageShow = (event) => this.#handlePageShow(event);

    constructor(options = {}) {
        super();
        this.#options = normalizeOptions(options);
        this.#frame = new Uint8Array(this.#options.maxLength);
    }

    static checkSupport() {
        if (!globalThis.isSecureContext) {
            return { supported: false, reason: 'insecure-context' };
        }
        if (!globalThis.navigator?.serial) {
            return { supported: false, reason: 'unavailable' };
        }
        return { supported: true, reason: null };
    }

    get connected() {
        return this.#port !== null;
    }

    get device() {
        return this.#port ? portIds(this.#port) : null;
    }

    // reopens the remembered scanner if this site already has permission for it
    async start() {
        this.#assertSupported();
        this.#attach();
        return this.#openGranted();
    }

    // shows the browser's port picker, so it must be called from a click/tap handler
    async requestPort() {
        this.#assertSupported();
        this.#attach();
        const filters = this.#options.filters;
        let port;
        try {
            port = await navigator.serial.requestPort(filters.length ? { filters } : {});
        } catch (error) {
            // NotFoundError: the picker was closed without choosing a port
            if (error?.name !== 'NotFoundError') {
                this.#emitError('request', error);
            }
            return false;
        }
        if (port === this.#port) {
            return true;
        }
        this.#cancelReconnect();
        await this.#closePort('stopped');
        this.#reconnectCount = 0;
        return this.#openPort(port);
    }

    async stop() {
        if (!this.#running) {
            return;
        }
        this.#running = false;
        this.#cancelReconnect();
        navigator.serial.removeEventListener('connect', this.#onConnect);
        navigator.serial.removeEventListener('disconnect', this.#onDisconnect);
        window.removeEventListener('pagehide', this.#onPageHide);
        window.removeEventListener('pageshow', this.#onPageShow);
        await this.#closePort('stopped');
    }

    // stops, clears the remembered device and revokes this site's access to every granted port
    async forget() {
        await this.stop();
        this.#saveDevice(null);
        if (!WebSerialScanner.checkSupport().supported) {
            return;
        }
        for (const port of await navigator.serial.getPorts()) {
            // SerialPort.forget() shipped later than the rest of the API
            if (typeof port.forget === 'function') {
                await port.forget();
            }
        }
    }

    #assertSupported() {
        const { supported, reason } = WebSerialScanner.checkSupport();
        if (!supported) {
            throw new WebSerialUnavailableError(reason);
        }
    }

    #attach() {
        if (this.#running) {
            return;
        }
        this.#running = true;
        navigator.serial.addEventListener('connect', this.#onConnect);
        navigator.serial.addEventListener('disconnect', this.#onDisconnect);
        window.addEventListener('pagehide', this.#onPageHide);
        window.addEventListener('pageshow', this.#onPageShow);
    }

    async #openGranted() {
        if (this.#port || this.#opening) {
            return this.#port !== null;
        }
        let ports;
        try {
            ports = await navigator.serial.getPorts();
        } catch (error) {
            this.#emitError('reconnect', error);
            return false;
        }
        const port = this.#pickPort(ports);
        return port ? this.#openPort(port) : false;
    }

    #pickPort(ports) {
        const filters = this.#options.filters;
        const remembered = this.#loadDevice();
        let candidates = ports;
        if (filters.length) {
            candidates = candidates.filter((port) => matchesFilters(portIds(port), filters));
        }
        if (remembered) {
            candidates = candidates.filter((port) => sameDevice(portIds(port), remembered));
        }
        if (candidates.length > 1) {
            // identical scanners can't be told apart, so don't guess which one to open
            this.#emitError('reconnect', new Error(`${candidates.length} granted ports match, call requestPort() to choose one`));
            return null;
        }
        return candidates[0] ?? null;
    }

    async #openPort(port) {
        if (this.#opening || this.#port) {
            return port === this.#port;
        }
        this.#opening = true;
        try {
            await port.open(this.#options.serial);
        } catch (error) {
            // InvalidStateError here usually means the previous page hasn't released the port yet
            this.#emitError('open', error);
            this.#scheduleReconnect();
            return false;
        } finally {
            this.#opening = false;
        }
        if (!this.#running) {
            // stop() ran while open() was pending
            await this.#closeSerial(port, false);
            return false;
        }
        this.#port = port;
        this.#reconnectCount = 0;
        this.#saveDevice(portIds(port));
        this.#dispatch('connected', portIds(port));
        this.#reading = this.#readLoop(port);
        return true;
    }

    async #readLoop(port) {
        let ended = false;
        while (!ended && !this.#closing && port.readable) {
            const reader = port.readable.getReader();
            this.#reader = reader;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) {
                        ended = true;
                        break;
                    }
                    this.#consume(value);
                }
            } catch (error) {
                // framing, parity and overrun errors are non-fatal: port.readable comes back as a
                // fresh stream. a lost device leaves it null, which ends the loop
                if (!this.#closing) {
                    this.#emitError('read', error);
                }
            } finally {
                reader.releaseLock();
                this.#reader = null;
            }
        }
        if (this.#closing || this.#port !== port) {
            return;
        }
        this.#resetFrame();
        this.#port = null;
        this.#reading = null;
        await this.#closeSerial(port, false);
        this.#dispatch('disconnected', { reason: 'lost' });
        this.#scheduleReconnect();
    }

    // concurrent callers (stop, pagehide, requestPort) share one shutdown
    #closePort(reason) {
        if (!this.#closing) {
            this.#closing = this.#shutdown(reason).finally(() => {
                this.#closing = null;
            });
        }
        return this.#closing;
    }

    async #shutdown(reason) {
        const port = this.#port;
        if (!port) {
            return;
        }
        if (this.#reader) {
            // ends the pending read so the loop can release its lock. only rejects if the
            // stream already errored, which the loop reports
            await this.#reader.cancel().catch(() => {});
        }
        await this.#reading;
        await this.#closeSerial(port, true);
        this.#port = null;
        this.#reading = null;
        this.#resetFrame();
        this.#dispatch('disconnected', { reason });
    }

    async #closeSerial(port, report) {
        try {
            await port.close();
        } catch (error) {
            // InvalidStateError: already closed
            if (report && error?.name !== 'InvalidStateError') {
                this.#emitError('close', error);
            }
        }
    }

    #handleConnect() {
        if (this.#port) {
            return;
        }
        this.#cancelReconnect();
        this.#reconnectCount = 0;
        // the delay also gives the device time to finish enumerating before open()
        this.#scheduleReconnect();
    }

    #handleDisconnect(event) {
        if (event.target === this.#port && this.#reader) {
            // the pending read normally rejects on its own, cancel in case it doesn't
            this.#reader.cancel().catch(() => {});
        }
    }

    #handlePageHide() {
        this.#cancelReconnect();
        // release the port so the next page on this kiosk can open it
        this.#closePort('stopped');
    }

    #handlePageShow(event) {
        // back/forward cache restored this page after pagehide closed the port
        if (event.persisted && this.#running) {
            this.#openGranted();
        }
    }

    #scheduleReconnect() {
        if (!this.#running || this.#port || this.#reconnectTimer !== null) {
            return;
        }
        if (this.#reconnectCount >= this.#options.reconnectAttempts) {
            // out of retries until the next 'connect' event (scanner plugged in) resets the count
            return;
        }
        const delay = Math.min(this.#options.reconnectDelay * 2 ** this.#reconnectCount, MAX_RECONNECT_DELAY);
        this.#reconnectCount += 1;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#openGranted();
        }, delay);
    }

    #cancelReconnect() {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
    }

    #consume(chunk) {
        for (const byte of chunk) {
            if (this.#options.terminators.has(byte)) {
                this.#flush();
                continue;
            }
            // past maxLength only the count grows, so a runaway device can't grow memory
            if (this.#frameLength < this.#frame.length) {
                this.#frame[this.#frameLength] = byte;
            }
            this.#frameLength += 1;
        }
        this.#armIdleTimer();
    }

    #armIdleTimer() {
        clearTimeout(this.#idleTimer);
        this.#idleTimer = null;
        if (this.#frameLength > 0 && this.#options.idleTimeout > 0) {
            this.#idleTimer = setTimeout(() => this.#flush(), this.#options.idleTimeout);
        }
    }

    #resetFrame() {
        clearTimeout(this.#idleTimer);
        this.#idleTimer = null;
        this.#frameLength = 0;
    }

    #flush() {
        const length = this.#frameLength;
        const bytes = this.#frame.subarray(0, Math.min(length, this.#frame.length));
        this.#resetFrame();
        if (length === 0) {
            // the LF of a CRLF suffix
            return;
        }
        if (length > this.#frame.length) {
            this.#reject('too-long', length);
            return;
        }
        let value;
        try {
            value = this.#decoder.decode(bytes);
        } catch {
            this.#reject('invalid-encoding', length);
            return;
        }
        if (this.#options.trim) {
            value = value.trim();
        }
        if (value === '') {
            return;
        }
        if (!this.#options.allowedPattern.test(value)) {
            this.#reject('invalid-characters', length);
            return;
        }
        const now = Date.now();
        const repeated = value === this.#lastValue && now - this.#lastTime < this.#options.duplicateWindow;
        this.#lastValue = value;
        this.#lastTime = now;
        if (repeated) {
            this.#reject('duplicate', length);
            return;
        }
        this.#dispatch('scan', { value, receivedAt: now });
    }

    // no payload on purpose: rejected input never reaches listeners
    #reject(reason, length) {
        this.#dispatch('rejected', { reason, length });
    }

    #emitError(stage, error) {
        this.#dispatch('error', { stage, error });
    }

    #dispatch(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail: Object.freeze(detail) }));
    }

    #loadDevice() {
        const key = this.#options.storageKey;
        if (!key) {
            return null;
        }
        try {
            const device = JSON.parse(localStorage.getItem(key));
            return device && isUint16(device.usbVendorId) && isUint16(device.usbProductId)
                ? { usbVendorId: device.usbVendorId, usbProductId: device.usbProductId }
                : null;
        } catch {
            // storage blocked or a corrupt entry: behave as if nothing is remembered
            return null;
        }
    }

    #saveDevice(device) {
        const key = this.#options.storageKey;
        if (!key) {
            return;
        }
        try {
            if (device && isUint16(device.usbVendorId) && isUint16(device.usbProductId)) {
                localStorage.setItem(key, JSON.stringify({ usbVendorId: device.usbVendorId, usbProductId: device.usbProductId }));
            } else {
                localStorage.removeItem(key);
            }
        } catch {
            // storage blocked: reconnect still works through filters or a single granted port
        }
    }
}
