/* jshint node: true */
'use strict';

var os = require('os');
const si = require('systeminformation');

const allowedDiskKeys = ["device", "type", "name", "vendor", "serialNum", "interfaceType"];
const allowedPartitionKeys = ["name", "identifier", "type", "fstype", "mount", "label", "model", "serial", "protocol", "disk"];
const allowedSharedKeys = ["ip", "mac", "machineName"];


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
    return new Promise((resolve, reject) => {
        var final = {};
        si.system()
        .then(system => {
            final.system = system
            return si.networkInterfaces()
        })
        .then(networkInterfaces => {
            final.network = networkInterfaces.filter(intFace => {
                if(intFace.ip4 && intFace.mac) {
                    return Object.keys(intFace).map(key => {
                        if(key != "mac" && key != "ip4")
                            delete intFace[key]
                    })
                }
            })
            return si.osInfo()
        })
        .then(osInfo => {
            final.osInfo = osInfo;
            return _getDiskInfo(path)
        })
        .then(data => {
            if(data.partition) cleanUpObject(data.partition, allowedPartitionKeys)
            if(data.disk) cleanUpObject(data.disk, allowedDiskKeys)
            if(data.shared) cleanUpObject(data.shared, allowedSharedKeys)
            resolve({...final, ...data})
        })
        .catch(e => {
            reject({ error: e })
        })

    })
}

module.exports = lib;

var cleanUpObject = function (obj, allowedArray) {
    Object.keys(obj).map(key => {
        if(!allowedArray.includes(key))
            delete obj[key]
    })
}


// lib.diskinfo("/Volumes/Backup/Shastri Backup")
// .then(output => console.log(output))