from __future__ import annotations

from pathlib import Path
from typing import List,Dict

from dacToSim.common import invertDict
from dacToSim.constants.names.dacNames import INIT_AREA_CONTROL

from dacToSim.DataModel.Common import GetItemFullNameSpace
from dacToSim.DataModel.Device import Device


from dacToSim.DataModel.Project.Initializations import DeviceInitializations




def getDacInitializations(folderPath:Path, devices:List[Device]) -> List[DeviceInitializations]:
  initializationPath = folderPath

  initializationFiles = [x for x in initializationPath.glob("*.xml") if x.is_file()]

  areaControl : Path = folderPath.parent / f"{INIT_AREA_CONTROL}.xml"

  if areaControl.is_file():
    initializationFiles.append(areaControl)
 

  deviceKeys : Dict[Device,str] = invertDict(GetItemFullNameSpace(devices))


  initializations : List[DeviceInitializations] = []

  for initializationFile in initializationFiles:
    initializations.append( DeviceInitializations().fromPath(initializationFile, deviceKeys))

  return initializations
