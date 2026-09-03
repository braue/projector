from __future__ import annotations
from pathlib import Path
from typing import List,Dict,Literal
import re
import copy


from dacToSim.constants.regEx import defaultFlags
from dacToSim.DataModel.Common.regEx import removeComments
from dacToSim.DataModel.Common import nameSpace

from .constants import MASTER_UNIQUE_NAME_TYPES
from dacToSim.DataModel.Device.Declaration import DeviceDeclaration
from dacToSim.DataModel.FileTemplates import unqualifiedGvlTemplate as gvlTemplate
from dacToSim.DataModel.FileTemplates import qualifiedGvlTemplate as gvlQualTemplate



RE_GET_NAMESPACE = re.compile(r'<Name>(\w+)</Name>', defaultFlags)
RE_GET_TYPES = re.compile(r'(.*?)(?:\s*?):(?:\s*?)((?:DA_|SIM_)\w+)', defaultFlags)

RE_GET_VAR_NAMES = re.compile(r'(\w+)', defaultFlags)


class DeviceDeclarations(nameSpace):
  def __init__(self):
    self.name: str = ""
    self.declarations: List[DeviceDeclaration] = []

  def UpdateName(self, name:str):
    self.name = name
    for declaration in self.declarations:
      declaration.parentName = self.name

  def fromPath(self, path:Path):
    contents = removeComments(path.read_text())

    self.name = RE_GET_NAMESPACE.search(contents)[1]

    self.declarations = []

    for results in RE_GET_TYPES.finditer(contents):
      pouType : str = results[2].upper()
      for instanceResult in RE_GET_VAR_NAMES.finditer(results[1]):
        self.declarations.append(
          DeviceDeclaration(
            parentName=self.name,
            name=instanceResult[1],
            type=pouType,
            makeMasterUnique= pouType.upper() in MASTER_UNIQUE_NAME_TYPES)
        )
        
    return self
  
  def append(self, declaration: DeviceDeclaration):
    if not isinstance(declaration, DeviceDeclaration):
      raise TypeError(f"Expected DeviceDeclaration, got {type(declaration)}")
    self.declarations.append(declaration)
  
  def getNameOfType(self, typeName: str) -> List[str]:
    typeName = typeName.upper()
    return [decl.name for decl in self.declarations if decl.BaseType.upper() == typeName]
  
  def Merge(self, other: DeviceDeclarations):
    if not isinstance(other, DeviceDeclarations):
      raise TypeError(f"Expected DeviceDeclarations, got {type(other)}")

    for declaration in other.declarations:
      if declaration not in self.declarations:
        self.declarations.append(declaration)

    # Update imported declarations
    self.UpdateName(self.name) 

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



def buildDeviceDeclaration(data:DeviceDeclarations):
  declarationByType = {declaration.type: [] for declaration in data.declarations}
  for declaration in data.declarations:
    declarationByType[declaration.type].append(declaration.name)
  declarationByType = {k: sorted(v) for k, v in declarationByType.items()}

  declarationTypes = sorted(declarationByType.keys())

  declarations = []
  for typeName in declarationTypes:
    names = declarationByType[typeName]

    for i in range(0, len(names), 10):
        chunk = names[i:i+10]
        declarations.append(f"\t{', '.join(chunk)} : {typeName};")

    if typeName != declarationTypes[-1]:
      declarations.append('')
  
  return gvlTemplate.format(
      pouName=data.name,
      body="\n".join(declarations)
    )

