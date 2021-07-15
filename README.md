# webusb-serial

This is an partial implementation of WebSerial using WebUSB. You should avoid using this. All browsers that support WebUSB also support WebSerial in their currently shipping version, so there is really no need for for regular use.


### What does this library do?

If you have a USB to Serial dongle, this library allows you to access it in a similar way as you would using WebSerial. It contains drivers for the most common chipsets used in these dongles: FTDI, PL2303 and CP2102.

However... on Windows the dongle might be exclusively claimed by the system driver. In that case you cannot use WebUSB to access the device. But luckily WebSerial itself will work!


### How to use it?

Load the `webusb-serial.umd.js` file in the browser and call requestPort on WebUSBSerial. Then use it as you would any other WebSerial port.

    <script src='webusb-serial.umd.js></script>

    <script>

        const port = await WebUSBSerial.requestPort();

    </script>


Or import the `webusb-serial.esm.js` module:

    import WebUSBSerial from 'webusb-serial.esm.js';

    const port = await WebUSBSerial.requestPort();


### What is implemented?

This is a work in progress and nowhere near complete implementation of the WebSerial API. There will be features missing.

What does not work for sure: signals and events. 

What might also not work: everything else.



### License

MIT
