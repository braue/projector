from pathlib import Path
from typing import List,Dict
import re
import copy


from dacToSim.DataModel.Common import nameSpace

from dacToSim.DataModel.Device.Definition import DeviceDefinition
from dacToSim.DataModel.FileTemplates import qualifiedGvlTemplate as template


class DeviceDefinitions(nameSpace):
  def __init__(self, name:str, definitions:List[DeviceDefinition]):
    self.name = name
    self.definitions = definitions

    if not definitions:
      print(f"DeviceDefinitions '{name}' initialized with no definitions")

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result    
  
  @property
  def qualifiedName(self) -> str:
    return self.name
  
  @property
  def unQualifiedName(self) -> str:
    return self.name
  
  def UpdateName(self, name:str):
    self.name = name
    for definition in self.definitions:
      definition.parentName = self.name



  

def buildDeviceDefinition(contents:DeviceDefinition):
  name = contents.name
  defType = contents.type
  params = ', '.join(param.write(":=", '\n\t\t') for param in contents.parameters)

  defTemplate = f'''\t{name} : {defType} := ({params}
\t);'''
  
  body = []
  params = ', '.join(param.write(":=", '\n\t') for param in contents.parameters)
  
  body.append(defTemplate.format(name=contents.name, type=contents.type, params=params))
  return defTemplate.format(
      pouName=contents.name,
      body="\n".join(body)
    )




def buildDeviceDefinitions(data:DeviceDefinitions):
  body = []
  if data.definitions:
    for devDef in data.definitions:
      body.append(buildDeviceDefinition(devDef))
  else:
    print(f"Initializing {data.name} as empty")
  return template.format(
      pouName=data.name,
      body="\n\n".join(body)
    )




