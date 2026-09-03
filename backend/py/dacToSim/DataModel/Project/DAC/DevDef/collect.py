
import re
from typing import List
from pathlib import Path


from dacToSim.DataModel.Common import VarAssignment, regEx

from dacToSim.DataModel.Profile import Scheme
from dacToSim.DataModel.Device.Definition import DeviceDefinition

from dacToSim.DataModel.Project.Definitions import DeviceDefinitions


def _parseParameters(contents:str) -> List[VarAssignment]:
  parameters : List[VarAssignment] = []

  for param_match in regEx.GET_PARAMETERS_COMMENTS_STRIPPED.finditer(contents):
      parameters.append(VarAssignment().fromParameterMatch(param_match))
  return parameters



def _parseDeviceDefs(contents:str,parentName:str)->List[DeviceDefinition]:
  devDefs: List[DeviceDefinition] = []
  
  for match in regEx.GET_DEV_DEF.finditer(contents):
    devDefs.append(
      DeviceDefinition(
        name = match.group(1),
        parentName = parentName,
        devType = match.group(2),
        parameters = _parseParameters(match.group(3))
    ))
  return devDefs

def getDacDevDefs(folderPath:Path, profile:Scheme) -> List[DeviceDefinitions]:
  deviceDefinitionSets: List[DeviceDefinitions] = []

  devDefRoot = folderPath

  devDefFiles = list(devDefRoot.glob('*.xml'))

  if (len(devDefFiles) == 0):
    raise FileNotFoundError(f"No device definition files found in {devDefRoot}")

  for devDefFile in devDefFiles:
    body = devDefFile.read_text()

    namespace = re.search(r'<Name>(.*?)</Name>', body).group(1)

    deviceDefinitionSets.append(
      DeviceDefinitions(
        name= namespace,
        definitions=_parseDeviceDefs(re.search(r'<!\[CDATA\[(.*?)\]\]>', body, re.DOTALL).group(1), namespace )
    ))

  return deviceDefinitionSets
