import WebUSBSerial from "../main.js";
import EventEmitter from "../event-emitter.js";



const DeviceIds = [
    { vendorId: 0x067b, productId: 0x2303 },
    { vendorId: 0x0557, productId: 0x2008 }
]


class DriverPL2303 {

    constructor(device) {
        this._internal = {
            emitter:    new EventEmitter(),
            device:     device,
            endpoints:  {
                int:        null,
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
            if (endpoint.direction == 'in' && endpoint.type == 'interrupt') {
                this._internal.endpoints.int = endpoint;
            }

            if (endpoint.direction == 'in' && endpoint.type == 'bulk') {
                this._internal.endpoints.in = endpoint;
            }

            if (endpoint.direction == 'out' && endpoint.type == 'bulk') {
                this._internal.endpoints.out = endpoint;
            }
        });
        
        
        /* Initialize the device */		            

        await vendorRead(this._internal.device, 0x8484, 0);
        await vendorWrite(this._internal.device, 0x0404, 0);
        await vendorRead(this._internal.device, 0x8484, 0);
        await vendorRead(this._internal.device, 0x8383, 0);
        await vendorRead(this._internal.device, 0x8484, 0);
        await vendorWrite(this._internal.device, 0x0404, 1);
        await vendorRead(this._internal.device, 0x8484, 0);
        await vendorRead(this._internal.device, 0x8383, 0);
        await vendorWrite(this._internal.device, 0, 1);
        await vendorWrite(this._internal.device, 1, 0);
        await vendorWrite(this._internal.device, 2, 0x44);
        
        
        /* Configure the device */		            

        await setConfiguration(this._internal.device, this._internal.options);
        
        
        /* Poll for incoming data */
        
        Promise.all([
            this._poll(),
            this._interupt()
        ]).then(() => {
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
                that._internal.device.transferIn(that._internal.endpoints.in.endpointNumber, 256).then(transfer => {
                    if (transfer.status === 'ok') {
                        that._internal.controller.enqueue(transfer.data.buffer);
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
    
    _interupt() {
        return new Promise((resolve) => {
            let that = this;
            let closing = false;

            this._internal.emitter.on('closing', () => {
                closing = true
            });

            function poll() {
                that._internal.device.transferIn(that._internal.endpoints.int.endpointNumber, 256).then(transfer => {
                    if (transfer.status === 'ok') {
                        that._internal.controller.enqueue(transfer.data.buffer);
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

function vendorRead(device, value, index) {
    return device.controlTransferIn({
        requestType: 'vendor',
        recipient: 'device',
        request: 0x01,
        value: value,
        index: index
    }, 1);
}
    
function vendorWrite(device, value, index) {
    return device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: 0x01,
        value: value,
        index: index
    }, new Uint8Array([]));
}

function setConfiguration(device, options) {
    const SupportedBaudrates = [
        75, 150, 300, 600, 1200, 1800, 2400, 3600,
        4800, 7200, 9600, 14400, 19200, 28800, 38400,
        57600, 115200, 230400, 460800, 614400,
        921600, 1228800, 2457600, 3000000, 6000000,
    ];
    
    const list = SupportedBaudrates.slice().sort((a, b) => Math.abs(a - options.baudRate) - Math.abs(b - options.baudRate));
    const baudRate = list[0];
    
    return new Promise(async (resolve, reject) => {
        try {
            let parameters = await device.controlTransferIn({
                requestType: 'class',
                recipient: 'interface',
                request: 0x21,
                value: 0,
                index: 0
            }, 7);
            
            parameters.data.setUint32(0, baudRate, true);
            parameters.data.setUint8(4, options.stopBits);
            parameters.data.setUint8(5, options.parity);
            parameters.data.setUint8(6, options.dataBits);

            await device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x20,
                value: 0,
                index: 0
            }, parameters.data);
            
            await vendorWrite(device, 0, 0);
            await vendorWrite(device, 8, 0);
            await vendorWrite(device, 9, 0);
            
            resolve();
        }
        catch(error) {
            console.log('Could not set baudrate! ' + error);
            reject();
        }
    });
}

DriverPL2303._filters = DeviceIds

export default DriverPL2303;