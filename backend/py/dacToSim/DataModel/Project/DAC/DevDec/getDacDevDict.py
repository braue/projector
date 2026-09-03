import re

from pprint import pprint

from dacToSim.constants.regEx import defaultFlags
from dacToSim.DataModel.Device.Declaration import DeviceDeclaration
from dacToSim.DataModel.Project.Declarations import MASTER_UNIQUE_NAME_TYPES

from typing import List,Dict

RE_GET_NAMESPACE = re.compile(r'<Name>(\w+)</Name>')
RE_GET_TYPES = re.compile(r'(.*?)(?:\s*?):(?:\s*?)(DA_\w+)', defaultFlags)

def getDacDevDict(contents) -> Dict[str,DeviceDeclaration]:
  print("getDacDevDict: Actually doing things")
  input()


  nameSpace = RE_GET_NAMESPACE.search(contents).group(1)

  pouInstances = {}

  
  for results in RE_GET_TYPES.finditer(contents):
    pouType = results[2].upper()
    instances = results[1]

    if pouType not in pouInstances:
      pouInstances[pouType] = []

    instanceResults = re.finditer(r'(\w+)', instances, flags= defaultFlags)
    for instanceResult in instanceResults:
      pouInstances[pouType].append(instanceResult[1])

  devInstancesList :List[DeviceDeclaration] = {}
  for key, instances in pouInstances.items():
    for instance in instances:
      devInstancesList.append(DeviceDeclaration(instance, key, key.upper() in MASTER_UNIQUE_NAME_TYPES))

  devInstancesDict :List[DeviceDeclaration] = {}
  for devInstance in devInstancesList:
      devInstancesDict[devInstance.name] = devInstance

  return devInstancesDict

if __name__ == "__main__":
  from . import testCases


  deviceList = getDacDevDict(testCases.devDec)

  schemeFeeders = [k for k, i in deviceList.items() if i.upper() == 'DA_FDR']

  pprint(schemeFeeders)






