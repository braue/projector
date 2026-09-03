from pathlib import Path
from typing import List,Dict
import re
import copy

from dacToSim.DataModel.Common import nameSpace
from dacToSim.DataModel.Common import VarAssignment




class DeviceDefinition(nameSpace):
  def __init__(self, name :str, parentName:str, devType, parameters):
    self.name:str = name
    self.parentName:str = parentName
    self.type:str = devType
    self.parameters:List[VarAssignment] = parameters

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
    return f"{self.parentName}.{self.name}"
  
  @property
  def unQualifiedName(self) -> str:
    return self.name

  
  @property
  def BaseType(self) -> str:
    return self.type.upper().replace('TYPEBASE', '').replace('TYPE', '').replace('DEVICEDEF', '')
