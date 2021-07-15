import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import pkg from './package.json';

export default [

	// Browser-friendly UMD build
	{
		input: 'src/main.js',
		output: {
			name: 'WebUSBSerial',
			file: pkg.browser,
			format: 'umd'
		},
		plugins: [
			resolve(), // so Rollup can find `WebUSBSerial`
			commonjs() // so Rollup can convert `WebUSBSerial` to an ES module
		]
	},

	// ES module (for bundlers) build.
	{
		input: 'src/main.js',
		output: { 
			file: pkg.module, 
			format: 'es' 
		}
	}
];
