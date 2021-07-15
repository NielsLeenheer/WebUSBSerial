import DriverPL2303 from './drivers/pl2303.js';
import DriverCP2102 from './drivers/cp2102.js';
import DriverFTDI from './drivers/ftdi.js';


class WebUSBSerial {

	static async getPorts() {
		let filters = WebUSBSerial._getFilters();								
    	let devices = await navigator.usb.getDevices({ filters });

        return devices.map(device => {
            let driver = WebUSBSerial._getDriverForDevice(device);
            return new driver(device);
        });
	}

    static async requestPort(options) {
		let filters = WebUSBSerial._getFilters();								

		if (filters && options && options.filters) {
			filters = options.filters.map(filter => {
				let candidates = filters;

				candidates = candidates.filter(f => f.vendorId === filter.usbVendorId);

				if (filter.usbProductId) {
					candidates = candidates.filter(f => f.productId === filter.usbProductId);
				}

				return candidates;
			}).reduce((a, b) => a.concat(b));
		}
		
		let device = await navigator.usb.requestDevice({ filters });	          						

        let driver = WebUSBSerial._getDriverForDevice(device);
        return new driver(device);
    }


    static _getFilters() {
        return WebUSBSerial._drivers.map(driver => driver._filters).reduce((a, b) => a.concat(b));
    }

    static _getDriverForDevice(device) {
        return WebUSBSerial._drivers.filter(
            driver => driver._filters.filter(
                filter => filter.vendorId === device.vendorId && filter.productId === device.productId
            ).length
        ).pop()
    }
}

WebUSBSerial._drivers = [
	DriverFTDI,
	DriverPL2303,
	DriverCP2102
];



WebUSBSerial.Parity = {
	None:	0,
	Odd:	1,
	Even:	2,
	Mark:	3,
	Space:	4,	
};

WebUSBSerial.StopBits = {
	One:			0,
	OnePointFive:	1,
	Two:			2,
};

export default WebUSBSerial;