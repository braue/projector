from typing import List

import re

from dacToSim.DataModel.Device.Declaration import DeviceDeclaration


def updateVarName(old:str, schemeName:str):
  if schemeName.upper() not in old.upper():
    return f'{schemeName}_{old}'
  else:
    temp = re.sub(f'{schemeName}_','',old, flags= re.MULTILINE|re.IGNORECASE)
    return f'{schemeName}_{temp}'


def getNamesToUpdate(devDec:List[DeviceDeclaration]) -> List[str]:
  return [v.name for v in devDec if v.makeMasterUnique]