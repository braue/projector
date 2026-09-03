from pathlib import Path
from typing import List,Dict
import re
import copy



from dacToSim.constants import regEx
from dacToSim.DataModel.Common import nameSpace

class DeviceDeclaration(nameSpace):
  def __init__(self, parentName:str, name:str, type:str, makeMasterUnique:bool):
      self.parentName:str = parentName
      self.name:str = name
      self.type:str = type
      self.makeMasterUnique:bool = makeMasterUnique

  @property
  def qualifiedName(self) -> str:
    return f"{self.parentName}.{self.name}"
  
  @property
  def unQualifiedName(self) -> str:
    return self.name
  
  @property
  def BaseType(self) -> str:
    return self.type.upper().replace("DA_", "").replace("SIM_", "").replace("_REMOTE", "")

  def __eq__(self, other):
    if not isinstance(other, DeviceDeclaration):
      return NotImplemented
    return self.name == other.name and self.type == other.type 

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
