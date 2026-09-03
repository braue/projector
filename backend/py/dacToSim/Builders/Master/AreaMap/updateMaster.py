import re
from pathlib import Path
from typing import List, Dict

from dacToSim.DataModel.Project import MasterProject

from .buildMaster import buildMasterAreaMap

from dacToSim.DataModel.CfcProcessor import CfcFile



def updateMasterAreaMap(filePath:Path, project:MasterProject, newAreaSources:Dict[str,List[str]] = {}) -> str:
  ''' Update the master area map with the new area maps '''

  areaMaps : Dict[str,CfcFile] = {}

  for dacSet in project.sets:
    dac = dacSet.dac[0]
    if not dac:
      continue

    areaMap = f"{dac.Scheme.schemeName}_AreaMap"
    targetPath = dacSet.paths.areaMap / f"{areaMap}.xml"

    areaMaps[dac.Scheme.schemeName] = CfcFile('FunctionBlock').fromFile(targetPath)
  
  return buildMasterAreaMap(filePath, areaMaps, newAreaSources)

