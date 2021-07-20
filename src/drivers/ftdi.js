import WebUSBSerial from "../main.js";
import EventEmitter from "../event-emitter.js";



const DeviceIds = [
    { vendorId: 0x0403, productId: 0x6001 },
    { vendorId: 0x0403, productId: 0x6010 },
    { vendorId: 0x0403, productId: 0x6011 },
    { vendorId: 0x0403, productId: 0x6014 },
    { vendorId: 0x0403, productId: 0x6015 },
    { vendorId: 0x1504, productId: 0x0011 },    // Bixolon
]


class DriverFTDI {

    constructor(device) {
        this._internal = {
            emitter:    new EventEmitter(),
            device:     device,
            endpoints:  {
                in:         null,
                out:        null
            },
            options:    {
                baudRate:	9600,
                stopBits:	WebUSBSerial.StopBits.One,
                parity:		WebUSBSerial.Parity.None,
                dataBits:	8
            }
        }
        
        this.readable = new ReadableStream({
            start: (controller) => {
                this._internal.controller = controller;
            }
        });
        
        this.writable = new WritableStream({
            write: (chunk, controller) => {
                this._send(chunk);
            }
        });
    }
                    
    async open(options) {
        this._internal.options = Object.assign(this._internal.options, options);


        /* Open the device */
        
        await this._internal.device.open();


        /* Claim the first interface */
        
        let iface = this._internal.device.configuration.interfaces[0];
        await this._internal.device.claimInterface(iface.interfaceNumber);
        

        /* Find the correct endpoints */
        
        iface.alternate.endpoints.forEach(endpoint => {
            if (endpoint.direction == 'in' && endpoint.type == 'bulk') {
                this._internal.endpoints.in = endpoint;
            }

            if (endpoint.direction == 'out' && endpoint.type == 'bulk') {
                this._internal.endpoints.out = endpoint;
            }
        });

                    
        /* Reset device */
        
        let transfer = await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x00,				// SIO_RESET
            value: 0x00,				// SIO_RESET_SIO
            index: iface.interfaceNumber
        }, new Uint8Array([]));
        
        
        /* Set bitmode */
        
        transfer = await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x0b,				// SIO_SET_BITMODE
            value: 0x00,				// BITMODE_RESET
            index: iface.interfaceNumber
        }, new Uint8Array([]));
        

        /* Set baudrate */

        let [ value, index ] = convertBaudrate(this._internal.options.baudRate, this._internal.device, iface.interfaceNumber);

        transfer = await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x03,				// SIO_SET_BAUDRATE
            value: value,
            index: index
        }, new Uint8Array([]));


        /* Set data bits, parity and stop bits */

        let config = this._internal.options.dataBits & 0x0f;
        config |= this._internal.options.parity << 8;
        config |= this._internal.options.stopBits << 11;
        
        transfer = await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x04,				// SIO_SET_DATA
            value: config,
            index: iface.interfaceNumber
        }, new Uint8Array([]));
        
        
        /* Poll for incoming data */
                
        this._poll().then(() => {
            this._internal.emitter.emit('stopped');
        });

        return this;		            		            
    }

    close() {
        return new Promise((resolve) => {
            this._internal.emitter.emit('closing');

            this._internal.emitter.on('stopped', async () => {
                await this._internal.device.close();
                resolve();
            })
        });
    }

    getInfo() {
        return {
            usbVendorId:    this._internal.device.vendorId,
            usbProductId:   this._internal.device.productId
        }
    }

    _send(data) {
        return this._internal.device.transferOut(this._internal.endpoints.out.endpointNumber, data);
    }

    _poll() {
        return new Promise((resolve) => {
            let that = this;
            let closing = false;

            this._internal.emitter.on('closing', () => {
                closing = true
            });

            function poll() {
                that._internal.device.transferIn(that._internal.endpoints.in.endpointNumber, 4 << 10).then(transfer => {
                    if (transfer.status === 'ok') {
                        if (transfer.data.byteLength != 2) {
                            that._internal.controller.enqueue(transfer.data.buffer.slice(2));
                        }
                    }
                    
                    if (closing) {
                        resolve();
                    } 
                    else {
                        poll();
                    }
                });
            }

            poll();
        });
    }
}



/* Private helper functions */

function isLegacy(device) {
    return device.deviceVersionMajor < 2;
}

function isModern(device) {
    return [ 7, 8, 9 ].includes(device.deviceVersionMajor);
}
    
function hasMPSSE(device) {
    return [ 5, 7, 8, 9 ].includes(device.deviceVersionMajor);
}

function convertBaudrate(baudrate, device, iface) {
    let BAUDRATE_REF_BASE = 3.0e6;
    let BAUDRATE_REF_HIGH = 12.0e6;
    
    /* Determine reference clock */
        
    let refclock, hispeed;
    
    if (baudrate < Math.floor((2 * BAUDRATE_REF_BASE) / (2 * 16384 + 1))) throw new Error('Baudrate too low');
    if (baudrate > BAUDRATE_REF_BASE) {
        if (!isModern(device) || baudrate > BAUDRATE_REF_HIGH) throw new Error('Baudrate too high');
        
        refclock = BAUDRATE_REF_HIGH;
        hispeed = true;
    } else {
        refclock = BAUDRATE_REF_BASE;
        hispeed = false;
    }
    
    
    let am_adjust_up = [0, 0, 0, 1, 0, 3, 2, 1];
    let am_adjust_dn = [0, 0, 0, 1, 0, 1, 2, 3];
    
    let frac_code = [0, 3, 2, 4, 1, 5, 6, 7];
    
    let divisor = Math.floor((refclock * 8) / baudrate);
    if (isLegacy(device)) {
        divisor -= am_adjust_dn[divisor & 7];
    }
    
    let best_divisor = 0;
    let best_baud = 0;
    let best_baud_diff = 0;
    
    
    for (let i of [0, 1]) {
        let try_divisor = divisor + i;
        
        if (!hispeed) {
        
            if (try_divisor <= 8) {
                try_divisor = 8;
            }
            else if (isLegacy(device) && try_divisor < 12) {
                try_divisor = 12;
            }
            else if (try_divisor < 16) {
                try_divisor = 16;
            }
            else {
                if (isLegacy(device)) {
                    try_divisor += am_adjust_up[try_divisor & 7];
                    if (try_divisor > 0x1fff8) {
                        try_divisor = 0x1fff8;
                    }
                }
                else {
                    if (try_divisor > 0x1ffff) {
                        try_divisor = 0x1ffff;
                    }
                }
            }
        }
        
        let baud_estimate = Math.floor(((refclock * 8) + Math.floor(try_divisor / 2)) / try_divisor);
        let baud_diff;
        
        if (baud_estimate < baudrate)
            baud_diff = baudrate - baud_estimate;
        else
            baud_diff = baud_estimate - baudrate;
            
        if ((i == 0) || (baud_diff < best_baud_diff)) {
            best_divisor = try_divisor;
            best_baud = baud_estimate;
            best_baud_diff = baud_diff;
            
            if (baud_diff == 0) {
                break;
            }
        }
    }
    

    let encoded_divisor = (best_divisor >> 3) | (frac_code[best_divisor & 7] << 14);
    
    if (encoded_divisor == 1)
        encoded_divisor = 0;
    else if (encoded_divisor == 0x4001)
        encoded_divisor = 1;
        
    let value = encoded_divisor & 0xFFFF;
    let index;

    if (hasMPSSE(device)) {
        index = (encoded_divisor >> 8) & 0xFFFF;
        index &= 0xFF00;
        index |= iface;
    }
    else {
        index = (encoded_divisor >> 16) & 0xFFFF;
    }
    
    if (hispeed) {
        index |= 1 << 9;
    }
    
    return [ value, index ];
}


DriverFTDI._filters = DeviceIds;


export default DriverFTDI;