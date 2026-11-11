# webserial-scanner

Reads barcode and RFID scanners running in USB serial (CDC-ACM) mode through the Web Serial API. One ES module, no dependencies, no build step.

### Requirements

- Firefox 151+ or Chromium 89+ (Chrome, Edge).
- A secure context: https, or `http://localhost`.
- The scanner set to USB serial / USB COM port mode, not keyboard (HID) mode.


### How to use it?

```js
import { WebSerialScanner } from './webserial-scanner.js';

const scanner = new WebSerialScanner({ filters: [{ usbVendorId: 0x1234 }] });

scanner.addEventListener('scan', (e) => {
    output.textContent = e.detail.value;
});

// reopens a scanner chosen on an earlier visit, no prompt
scanner.start();

// the port picker only opens from a click or tap
connectButton.addEventListener('click', () => scanner.requestPort());
```

The first connection needs `requestPort()` from a user gesture. After that, `start()` reopens the remembered scanner on page load and reconnects when it is unplugged and plugged back in.

Scan values are validated but still untrusted: write them to the page with `textContent` and into URLs with `encodeURIComponent`.

| Method | Does |
| --- | --- |
| `WebSerialScanner.checkSupport()` | Returns `{ supported, reason }`, reason is `'insecure-context'` or `'unavailable'`. |
| `start()` | Opens the remembered scanner if the site already has permission. Resolves `true` when connected. |
| `requestPort()` | Shows the browser's port picker and opens the chosen port. Resolves `false` if the picker is closed. |
| `stop()` | Closes the port and stops auto-reconnect. |
| `forget()` | Stops, clears the remembered device and revokes the site's access to every serial port it was granted. |
| `connected`, `device` | Connection state, and `{ usbVendorId, usbProductId }` of the open port or `null`. |

`start()` and `requestPort()` throw `WebSerialUnavailableError` when Web Serial is unavailable.

Events are `CustomEvent`s with the payload in `event.detail`:

| Event | `detail` |
| --- | --- |
| `scan` | `{ value, receivedAt }` |
| `rejected` | `{ reason, length }`, reason is `'too-long'`, `'invalid-encoding'`, `'invalid-characters'` or `'duplicate'` |
| `connected` | `{ usbVendorId, usbProductId }` |
| `disconnected` | `{ reason }`, `'stopped'` or `'lost'` |
| `error` | `{ stage, error }`, stage is `'request'`, `'open'`, `'read'`, `'close'` or `'reconnect'` |

Options (all optional):

| Option | Default | Notes |
| --- | --- | --- |
| `baudRate`, `dataBits`, `stopBits`, `parity`, `flowControl`, `bufferSize` | `9600`, `8`, `1`, `'none'`, `'none'`, `255` | Serial settings, match the scanner. |
| `filters` | `[]` | `{ usbVendorId, usbProductId? }` entries for the picker and auto-reconnect. Empty means any device. |
| `terminators` | `[0x0d, 0x0a]` | Bytes that end a scan (CR, LF). |
| `idleTimeout` | `300` | ms of silence that also ends a scan, for scanners with no suffix. `0` disables. |
| `maxLength` | `512` | Longer scans (in bytes) are dropped. |
| `allowedPattern` | no control or format characters | RegExp every scan must match. |
| `trim` | `true` | Trim surrounding whitespace. |
| `duplicateWindow` | `500` | ms; the same value again inside this window is rejected as a double read. |
| `storageKey` | `'webserial-scanner.device'` | localStorage key for the remembered device, `null` to disable. |
| `reconnectDelay`, `reconnectAttempts` | `1000`, `5` | First retry delay in ms (doubles each attempt, max 30 s) and retry count. `0` attempts disables. |


### Trying it with the demo

`src/demo.html` is a test page for checking a scanner end to end. Module scripts don't load from `file://`, so serve the folder locally:

```sh
cd src
python -m http.server 8000    # on Windows: py -m http.server 8000
```

Open `http://localhost:8000/demo.html`, then:

1. Check the first line. It says whether Web Serial is available, or why not.
2. Click **Connect scanner** and pick the scanner in the browser prompt. Status shows its USB vendor and product id.
3. Scan something. Each read is added to the top of the log. Rejected reads show the reason and byte count, never the content.
4. Reload the page: it reconnects with no prompt. Unplug the scanner and status reads `not connected (lost)`; plug it back in and it reconnects.
5. **Disconnect** closes the port until you reload or click Connect. **Forget scanner** also revokes permission, so the next connect shows the prompt again.

The demo runs with the defaults. If your scanner uses different serial settings or suffix, pass options where the demo creates it, e.g. `new WebSerialScanner({ baudRate: 115200 })`. The vendor id from step 2 is what goes in `filters`.

If something goes wrong in the demo:

- **Scanner missing from the prompt:** it's probably in keyboard mode. Scan the "USB CDC" or "USB COM port" setup barcode from the scanner's manual.
- **`error during open`:** another tab or program (serial terminal, vendor tool) has the port open. Close it; the page retries a few times, or click Connect again.
- **`rejected: invalid-encoding` on every scan:** the serial settings don't match the scanner, usually `baudRate`.


### License

MIT
