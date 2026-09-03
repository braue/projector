from __future__ import annotations
from typing import List,Dict
import copy

from dacToSim.DataModel.Common import nameSpace

from .Connections import ConnectionFiles

from .Declaration import DeviceDeclaration
from .Initialization import DeviceInitialization
from .Definition import DeviceDefinition



class Device(nameSpace):
  def __init__(self, deviceDeclaration:DeviceDeclaration):
    if not isinstance(deviceDeclaration, DeviceDeclaration):
      raise TypeError(f"Expected DeviceDeclaration, got {type(deviceDeclaration)}")

    self.name:str=deviceDeclaration.name
    self.deviceDeclaration:DeviceDeclaration=deviceDeclaration
    self.deviceDefinition:DeviceDefinition=None
    self.initialization:DeviceInitialization=None
    self.field:ConnectionFiles=None
    self.scada:ConnectionFiles=None

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
    return self.deviceDeclaration.qualifiedName
  
  @property
  def unQualifiedName(self) -> str:
    return self.deviceDeclaration.unQualifiedName
  
  def __str__(self) -> str:
    return f"Device(name={self.name}, field={self.field.connection.name}, scada={self.scada.connection.name})"
  
  def MergeInit(self, other:DeviceInitialization):
    """
    Merges the initialization methods from another DeviceInitialization into this device's initialization.
    If the device already has an initialization, it will merge the methods.
    """
    if not isinstance(other, DeviceInitialization):
      raise TypeError(f"Expected DeviceInitialization, got {type(other)}")

    if self.initialization is None:
      self.initialization = other
    else:
      self.initialization.MergeInit(other)
  
  def printReport(self):
    """
    Prints a report of the device.
    """
    print(f"Device: {self.name}")
    print(f"  Declaration: {self.deviceDeclaration.name}")
    if self.deviceDefinition:
      print(f"  Definition: {self.deviceDefinition.name}")
    else:
      print("  Definition: None")
    if self.field:
      print(f"  Field Connection: {self.field.connection.name}")
    else:
      print("  Field Connection: None")
    
    if self.scada:
      print(f"  SCADA Connection: {self.scada.connection.name}")
    else:
      print("  SCADA Connection: None")
    
    if self.initialization:
      print(f"  Initialization Methods: {len(self.initialization.methods)}")
    else:
      print("  Initialization Methods: None")



def getByField(devices:List[Device] ) -> Dict[ConnectionFiles,List[Device]]:
  """
  Returns a list of devices that have a field with the given name.
  """
  by : Dict[ConnectionFiles, List[Device]] = {}
  for device in devices:
    check = device.field
    if check is None:
      continue
    
    if check not in by:
      by[check] = []
    by[check].append(device)

  return by



def getByScada(devices:List[Device] ) -> Dict[ConnectionFiles,List[Device]]:
  """
  Returns a list of devices that have a field with the given name.
  """
  by : Dict[ConnectionFiles, List[Device]] = {}
  for device in devices:
    check = device.field
    if check is None:
      continue
    
    if check not in by:
      by[check] = []
    by[check].append(device)

  return by

