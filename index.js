/* jshint node: true */
'use strict';

var os = require('os');

var lib = {};

var _getDiskInfo;
switch (os.platform()) {

    case 'win32':
        _getDiskInfo = require('./lib/windows.js');
        break;

    // case 'linux':
    //     _getDiskInfo = require('./lib/linux.js');
    //     break;

    case 'darwin':
    // case 'sunos':
        _getDiskInfo = require('./lib/macosx.js');
        break;

    default:
        console.warn("node-HddSerialNumber: Unkown os.platform()");
        // _getDiskInfo = require('./lib/linux.js');
        break;

}

lib.diskinfo = async function (path) {

    return await _getDiskInfo(path)
};

module.exports = lib;
