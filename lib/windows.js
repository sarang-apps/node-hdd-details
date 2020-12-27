var execFile = require('child_process').execFile;
const si = require('systeminformation');
const fs = require('fs');
const Shell = require('node-powershell');
const { error } = require('console');
const find_ip = require('local-devices');
const os = require('os');

const ps = new Shell({
    verbose: false,
    executionPolicy: 'Bypass',
    noProfile: true,
});


async function diskInfo(path) {
    return new Promise(async function(resolve, reject) {
        try {
            if(fs.existsSync(path)) {
                const details = {}
                const requestedDriveLetter = path.substr(0,2).toUpperCase()
                const mapped = isMappedDrive(path.charAt(0))
                const partition = mapped ? await getPartitonDetails(path) : null
                const physical = partition && partition.length == 1 && partition[0].physical !== "Network"
                if(partition && partition.length == 1 && physical) details.partition = partition[0] 
                if(partition && partition.length == 1 && !physical) details.shared = partition[0] 

                if (physical) {
                    ps.addCommand('Get-WmiObject -Class Win32_LogicalDiskToPartition  |  Select-Object -Property Antecedent,Dependent | ConvertTo-Json')
                    ps.invoke().then(output => {
                        partitions = parsePatitions(output).filter(drive => drive.driveLetter == requestedDriveLetter)
                        if(partitions.length == 1) {
                            details.partition.disk = partitions[0].disk
                            details.partition.partition = partitions[0].partition
                        }
                    }).then(() => {
                        ps.addCommand('wmic diskdrive get Caption,Description,DeviceID,InterfaceType,MediaType,Model,Name,Partitions,SerialNumber,Status /FORMAT:value')
                        return ps.invoke()
                    }).then(async output => {
                        diskdrives = cleanJSON(parseDisks(output)).filter(drive => drive.DeviceID.replace(/.+(\d+)$/gm,`$1`) == details.partition.disk)
                        if(diskdrives.length == 1) {
                            disk = await getDriveDetails(diskdrives[0].SerialNumber)
                            details.disk = {
                                "description":diskdrives[0].Description,
                                "partitions":diskdrives[0].Partitions,
                                "mediaType":diskdrives[0].MediaType,
                                "model":diskdrives[0].Model
                            }
                            if(disk.length == 1) {
                                details.disk = { ...details.disk, ...disk[0] }
                            } else {
                                details.disk = { 
                                    ...details.disk,
                                    "interfaceType":diskdrives[0].InterfaceType,
                                    "smartStatus":diskdrives[0].Status,
                                    "serialNum":diskdrives[0].SerialNumber,
                                    "name":diskdrives[0].Caption
                                }
                            }
                            ps.addCommand(`lib\\smartctl\\smartctl.exe -a /dev/pd${details.partition.disk} -j`)
                            return ps.invoke()
                        }
                    }).then((output) => {
                        smartStatus = output && output.length>1 ? JSON.parse(output) : {}
                        if(smartStatus.serial_number) details.disk.serialNum = smartStatus.serial_number
                        ps.dispose();
                        resolve(details)
                    }).catch(err => {
                        console.log(err);
                        ps.dispose();
                        throw new Error(err)
                    });
                } else {
                    var isIPAddress, ipAddress, networkAddress, machineName
                    getNetworkAddress(path, mapped)
                    .then(async nAddress => {
                        networkAddress = nAddress
                        isIPAddress = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gm.test(networkAddress)
                        ipAddress = isIPAddress ? networkAddress.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gm)[0] : await getIPAddress(networkAddress)
                        machineName = isIPAddress ? await getMachineName(ipAddress) : networkAddress.match(/(?<=^\\\\)[^\\]+(?=\\)/gm)[0]
                        return find_ip()
                    }).then(async ips => {
                        ips = ips.filter(ip => ip.ip == ipAddress)
                        if(ips.length == 1) {
                            if(!details.shared) details.shared = {}
                            details.shared.ip = ips[0].ip
                            details.shared.mac = ips[0].mac
                            details.shared.machineName = machineName
                            resolve(details)
                        } else {
                            const myInterfaces = await si.networkInterfaces()
                            const ints = myInterfaces.filter(int => int.ip4 == ipAddress)
                            if(ints.length == 1) {
                                if(!details.shared) details.shared = {}
                                details.shared.ip = ints[0].ip4
                                details.shared.mac = ints[0].mac
                                details.shared.machineName = os.hostname()
                                resolve(details)
                            }
                        }
                        ps.dispose()
                    }).catch(error => {
                        throw new Error(error)
                    })
                    
                }
            } else {
                throw new Error("Invalid path")
            }
        } catch (error) {
            ps.dispose(); 
            reject(error)
        }
        

    });

}

function isMappedDrive(str) {
    return str.length === 1 && /[a-zA-Z]/i.test(str);
}

function getPartitonDetails(path) {
    return new Promise((resolve, reject) => {
        si.blockDevices()
        .then(partitions => {
            partition = partitions.filter(
                partition => partition.mount.toUpperCase() == path.substr(0,2).toUpperCase()
            )
            resolve(partition)
        }).catch(error => {
            reject(error)
        })
    })
    
}

function getDriveDetails(SerialNumber) {
    return new Promise((resolve, reject) => {
        si.diskLayout()
        .then(drives => {
            drive = drives.filter(
                drive => drive.serialNum == SerialNumber
            )
            resolve(drive)
        }).catch(error => {
            reject(error)
        })
    })
    
}

function parsePatitions(psout) {
    psout = JSON.parse(psout)
    psout = psout.map(drive => {
        const antecedent = drive.Antecedent.split("=")[1].slice(1,-1).split(", ")
        const driveLetter = drive.Dependent.split("=")[1].slice(1,-1)
        const disk = antecedent[0].substr(antecedent.indexOf("#"))
        const partition = antecedent[1].substr(antecedent.indexOf("#"))
        return { driveLetter, disk, partition }
    })

    return psout
}

function parseDisks(psout) {
    psout = psout.replace(/^(.+)=(.*)/gm,`"$1":"$2",`)
        .replace(/,\r\r\n\r/gm,`},\n{`)
        .replace(/\\/gm,`\\\\`)
        .slice(0,-11)
    psout = `[{${psout}]`
    return JSON.parse(psout)
}


function cleanJSON(json){
    return json.map(row => {
        const newObj = {}
        for(e in row) {
            newObj[e] = row[e].trim();
        }
        return newObj
    })
}

async function getNetworkAddress(path, mapped) {
    return new Promise((resolve, reject) => {
        try {
            const driveLetter = path.substr(0,2)
            if(mapped) {
                ps.addCommand(`wmic logicaldisk where 'DeviceID="${driveLetter}"' get DeviceID,FileSystem,ProviderName,VolumeName /FORMAT:VALUE`)
                ps.invoke().then(async output => {
                    map = await parseDisks(output)
                    resolve(map.length == 1 ? map[0].ProviderName : path)
                }).catch(error => {
                    throw new Error(error)
                })
            } else {
                resolve(path)
            }
        } catch (error) {
            reject(error)
        }
    })
}

function getIPAddress(path) {
    return new Promise((resolve, reject) => {
        const machineName = path.match(/(?<=^\\\\)[^\\]+(?=\\)/gm)
        console.log(machineName, path)
        ps.addCommand(` Test-Connection -computername ${machineName} -count 1 | Select-Object -Property IPV4Address,ProtocolAddress | ConvertTo-Json`)
        ps.invoke().then(async output => {
            jsonOut = JSON.parse(output)
            if(jsonOut.ProtocolAddress) { resolve(jsonOut.ProtocolAddress) } else return new Error("No IP Address found")
        }).catch(error => {
            reject(error)
        })
    })
}


function getMachineName(ipAddress) {
    return new Promise((resolve,reject) => {
        ps.addCommand(`nbtstat -A ${ipAddress} | ?{$_ -match '\<00\>  UNIQUE'} | %{$_.SubString(4,14)}`)
        ps.invoke().then(async machineName => {
            resolve(machineName)
        }).catch(error => {
            reject(error)
        })
    })
} 
// si.diskLayout().then(data => console.log("diskLayout", data));
// si.blockDevices().then(data => console.log("blockDevices", data));
// si.fsSize().then(data => console.log("fsSize", data));
// si.networkInterfaces().then(data => console.log(data));
// console.log(os.hostname())
module.exports = diskInfo


// diskInfo("B:\\windows\\system\\mytxt.txt")
// diskInfo("\\\\192.168.105.83\\data\\")
// .then(data => console.log(data))
// diskInfo("F:\\Clip0001.MXF")
// diskInfo("G:\\BAPS DAM.pdf")
// diskInfo("\\\\192.168.105.69\\data\\")
// .then(data => console.log(data))
