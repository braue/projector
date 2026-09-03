from pathlib import Path

from dacToSim.DataModel.Device import Device

from dacToSim.DataModel.Project import DacProject
from dacToSim.DataModel.Project.Declarations import DeviceDeclarations


def processDevDec(filePath:Path, dac:DacProject):
  devDecName = filePath.stem

  dacDevDec = getDevDecFromDac(devDecName, dac)
  fileDevDec = getDevDecFromPath(filePath)

  if not dacDevDec:
    dac.DevDec.append(fileDevDec)
  else:
    dacDevDec.Merge(fileDevDec)

  existingDevices = {dev.qualifiedName.upper(): dev for dev in dac.Devices}

  # Add devices to the DAC project devices
  for devDec in fileDevDec.declarations:
    if devDec.qualifiedName.upper() not in existingDevices:
      dac.Devices.append(Device(devDec))

def getDevDecFromPath(filePath:Path) -> DeviceDeclarations:
  devDec = DeviceDeclarations()
  if filePath.is_file():
    devDec.fromPath(filePath)
  else:
    devDec.UpdateName(filePath.stem)
  return devDec

def getDevDecFromDac(name:str, dac:DacProject) -> DeviceDeclarations:
  for devDec in dac.DevDec:
    if devDec.name.upper() == name.upper():
      return devDec
  return None