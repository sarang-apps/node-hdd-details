const si = require('systeminformation');
const fs = require('fs');
const execute = require('execute-shell-promise');
const multigrain = require('multigrain');
const find_ip = require('local-devices');

async function diskInfo(path) {
    return new Promise(async function(resolve, reject) {
        try {
            const details = {};
            let devices = {}
            if(fs.existsSync(path)) {
                si.blockDevices()
                .then(async bds => {
                    devices = bds
                    return si.fsSize()
                })
                .then(fs => extractMountedShares(fs, devices))
                .then(devices => {
                    let blockDevice = {"mount_len" : 0, "name": ""};
                    const filtered_bds = devices.filter(bd => {
                        const regex = new RegExp(escapeRegExp(bd.mount))
                        const pass = bd.mount && bd.mount.length > 0 && regex.test(path)
                        if(pass && bd.mount.length > blockDevice.mount_len) {
                            blockDevice.mount_len = bd.mount.length;
                            blockDevice.name = bd.name;
                        }
                        return pass 
                    })
                    return filtered_bds.filter(bd => bd.name == blockDevice.name)

                })
                .then(async bds => {
                    if(bds.length == 1) {
                        details.partition = bds[0]
                    } else {
                        throw new Error("Unable to find block device");
                    }
                    switch (details.partition.protocol) {
                        case 'SATA':
                            const diskNum = extractDiskNum(details)
                            return getSataDiskInfo(diskNum, details)
                        case 'USB':
                            diskNum = extractDiskNum(details)
                            return getUsbHwInfo(diskNum, details)
                        case 'NETWORK':
                            return getNetworkShareDetails(details)
                        default:
                            break;
                    }
                })
                .then(() => resolve(details))
                .catch(e => { throw new Error(e); })
            } else {
                throw new Error("Invalid path");
            }
        } catch (error) {
            reject(error)
        } 
        

    });

}

function extractDiskNum(details) {
    const diskNumberArray = details.partition.identifier.match(/(?<=disk)\d+/gmi)
    if (diskNumberArray.length == 1) {
        details.partition.disk = diskNum
        return diskNum
    } else {
        throw new Error("Unable retreive disk number");
    }
}

function getDiskFromContainer(diskName) {
    return new Promise((resolve, reject) => {
        execute('diskutil apfs list -plist | plutil -convert json -o - -')
        .then(containersJSON => {
            if(containersJSON.length > 0) {
                const containers = JSON.parse(containersJSON)
                const filtered_containers = containers.Containers.filter(container => container.ContainerReference == diskName)
                if(filtered_containers.length == 1) {
                    return filtered_containers[0].DesignatedPhysicalStore
                } else {
                    return "";
                }
            } else {
                return "";
            }
        })
        .then(diskNum => resolve(diskNum))
        .catch(e => {
            reject(e)
        })
    });
}

function getSataDiskInfo(diskNum, details) {
    return new Promise((resolve, reject) => {
        si.diskLayout()
        .then(async disks => {
            let filtered_disks =  disks.filter(disk => {
                disk.device == `disk${diskNum}`
            })
            if(filtered_disks.length == 1) {
                details.disk = filtered_disks[0]
            } else {
                const containerVolume = await getDiskFromContainer(`disk${details.partition.disk}`)
                const diskNumberArray = containerVolume.match(/(?<=disk)\d+/gmi)
                if(diskNumberArray && diskNumberArray.length == 1) {
                    details.partition.disk = diskNum
                    filtered_disks = disks.filter(disk => disk.device == `disk${diskNum}` )
                    if(filtered_disks.length == 1) {
                        details.disk = filtered_disks[0]
                    }
                }
            }
            return null
        })
        .then(() => resolve(details))
        .catch(e => reject(e))
    })
}

function getUsbHwInfo(diskNum, details) {
    return new Promise((resolve, reject) => {
        execute('system_profiler SPUSBDataType -xml -detailLevel full')
        .then(SPUSB => {
            const USB_obj = JSON.parse(multigrain.json(SPUSB, 'plist'))
            if(USB_obj.length == 1) {
                const master_items = USB_obj[0]._items;
                let mediaItems = []
                // console.log("MediaItems", typeof master_items, master_items.length)
                mediaItems = getUSBMediaInfo(master_items, mediaItems)
                const disk = getUSBDetails(mediaItems,diskNum)
                details.disk = disk
                resolve(disk);
            }
        })
        .catch(e => reject(e))
    })
}

function getUSBMediaInfo(items, mediaItems) {
    items.map(item => {
        if(item.Media && typeof item.Media == 'object' && item.Media.length) {
            mediaItems.push(item)
        } else if (item._items && typeof item._items == 'object' && item._items.length) {
            return getUSBMediaInfo(item._items, mediaItems)
        }
    })
    return mediaItems
}

function getUSBDetails(items, diskNum) {
    const devices = items.filter(item => {
        const matched_media = item.Media.filter(media => media.bsd_name == `disk${diskNum}` )
        if(matched_media.length > 0) return item 
    })
    if(devices.length == 1) {
        return formatUSBDevice(devices[0], diskNum)
    } else {
        return null
    }
}

function formatUSBDevice(device, diskNum) {
    return {
        'device': `disk${diskNum}`,
        'type' : 'USB',
        'name': device._name,
        'vendor': device.manufacturer,
        'serialNum':device.serial_num,
        'interfaceType': 'USB'
    }
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
  }

function extractMountedShares(fs, devices) {
    fs.map(f => {
        if (devices.findIndex(device => device.name == f.fs) == -1) {
            devices.push({
                "name" : f.fs,
                "fstype" : f.type,
                "mount" : f.mount,
                "protocol" : "NETWORK"
            })
        }
    })
    return devices
}

function extractIpAddress(shareAddress) {
    const ip_match = shareAddress.match(/(?<=[@\/])(?:\d{1,3}\.){3}\d{1,3}(?=\/)/gm)
    if(ip_match && ip_match.length == 1){
        return ip_match[0]
    } else if (/(?<=\/\/[^@]+@).+(?=\/)/g.test(shareAddress)) {
        return null
    }
    return null
}

function getMacAddress(details) {
    return new Promise((resolve, reject) => {
        find_ip()
        .then(ips => {
            ips = ips.filter(ip => ip.ip == details.shared.ip)
            if(ips.length == 1) {
                details.shared.mac = ips[0].mac
            }
            resolve()
        })
        .catch(e => reject(e));
    })
}

async function getNetworkShareDetails(details) {
    let ipAddress = extractIpAddress(details.partition.name)
    details.shared = {}
    details.shared.ip = ipAddress
    await getMacAddress(details)

}

module.exports = diskInfo

// si.diskLayout().then(data => console.log("diskLayout", data));
// si.blockDevices().then(data => console.log("blockDevices", data));
// si.fsSize().then(data => console.log("fsSize", data));

// diskInfo("/Volumes/niranjananand/drk fonts")
// diskInfo("/Volumes/data/")
// diskInfo("/Volumes/ftp.cs.brown.edu/pub/")
// diskInfo("/Users/computerroom/Downloads/BAPS\ DAM.pdf")
// .then(output => console.log(output))