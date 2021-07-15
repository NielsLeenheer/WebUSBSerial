import WebUSBSerial from "../main.js";
import EventEmitter from "../event-emitter.js";


const DeviceIds = [
    { vendorId: 0x10c4, productId: 0xea60 }
]

class DriverCP2102 {
    
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

        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x00,
            index: 0x00,
            value: 0x01
        });
        

        /* Set modem handshaking */
        
        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x07,
            index: 0x00,
            value: 0x03 | 0x0100 | 0x0200		// 0000001100000011 -> enable DTR and RTS
        });
    

        /* Set baudrate divisor */

        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x01,
            index: 0x00,
            value: 0x384000 / this._internal.options.baudRate 	// 115200
        });
        
        
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
}


DriverCP2102._filters = DeviceIds


export default DriverCP2102;