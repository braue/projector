

from typing import Dict, List
from pathlib import Path


from dacToSim.common import invertDict
from dacToSim.DataModel.Common import GetItemFullNameSpace

from dacToSim.DataModel.Device import Device

from dacToSim.DataModel.Project import DacProject
from dacToSim.DataModel.Project.Initializations import DeviceInitializations

def processInit(filePath:Path, dac:DacProject):
  # Imports any existing transformer initializations from the file
  # If the device already exists in the DAC project the project values will be used
  # If the device does not exist in the DAC project appended the device initialization to the DAC project

  inits : List[DeviceInitializations] = dac.Inits
  devices: Dict[Device,List[str]] = invertDict(GetItemFullNameSpace(dac.Devices))
  
  initName = filePath.stem
  dacInit = getInitFromList(initName, inits)
  fileInit = getInitFromPath(filePath, devices)

  if not dacInit:
    dac.Inits.append(fileInit)
  elif fileInit.devices:
    dacInit.Merge(fileInit)

def getInitFromPath(filePath:Path, devices: Dict[Device,List[str]]) -> DeviceInitializations:
  inits: DeviceInitializations = DeviceInitializations()
  if filePath.is_file():
    inits.fromPath(filePath, devices)
  else:
    inits.UpdateName(filePath.stem) 
  return inits

def getInitFromList(name:str, inits : List[DeviceInitializations]) -> DeviceInitializations:
  for init in inits:
    if init.name.upper() == name.upper():
      return init 
  return None