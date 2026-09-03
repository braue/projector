from __future__ import annotations

from pathlib import Path
from typing import List,Dict,Literal, Tuple,Callable
import re
from re import Pattern, Match
import copy

from dacToSim.DataModel.Common import nameSpace

from dacToSim.constants.regEx import defaultFlags
from dacToSim.constants.projectTypes import REMOTE_IO


from dacToSim.common import invertDict


from dacToSim.DataModel.Common import regEx
from dacToSim.DataModel.Common import VarAssignment, Method
from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Initialization import DeviceInitialization

from dacToSim.DataModel.Profile import Scheme




def _removeComments(contents):
  filterContents = re.sub(r'//.*','',contents, flags= defaultFlags)

  while True:
    length = len(filterContents)
    filterContents = re.sub(r'\(\*(?:.*?)\*\)','',filterContents, flags= defaultFlags | re.DOTALL)

    if (length == len(filterContents)):
      break
  return filterContents




GET_POU_NAME = re.compile(r"<Name>(\w+)</Name>\s*\n\s*<POUKind>", re.IGNORECASE | re.MULTILINE)
GET_IMPLEMENTATION = re.compile(r"<Implementation><!\[CDATA\[(.*?)\]\]></Implementation>", re.IGNORECASE | re.MULTILINE | re.DOTALL)


class DeviceInitializations(nameSpace):
  def __init__(self):
    self.name: str = ""
    self.devices: set[Device] = set()

  def UpdateName(self, name:str):
    self.name = name

  def fromPath(self, path:Path, deviceKeys:Dict[Device,List[str]]):
    body = path.read_text()
    self.name = GET_POU_NAME.search(body).group(1)
    try:
      implementation = _removeComments(GET_IMPLEMENTATION.search(body).group(1))
    except AttributeError:
      raise ValueError(f"Could not find implementation in {path}")
    

    self.devices = set()

    # key is device name
    workingInitializations : Dict[str,DeviceInitialization] = {}

    projectKeyedDevices : Dict[str,Device] = {}
    for device, keys in deviceKeys.items():
      for key in keys:
        projectKeyedDevices[key.upper()] = device

    for match in regEx.GET_CALLS.finditer(implementation):
      callId = match[1].strip('.')
      callBody = match[2]

      if callId.upper() in projectKeyedDevices:
        devName = callId
        callName = 'self'
      else:
        parts = callId.split('.')
        devName = '.'.join(parts[:-1]         )
        callName = parts[-1]

      newMethod = Method().fromNameBody(callName, match[2])
      
      try:
        if devName.upper() not in workingInitializations:
          workingInitializations[devName.upper()] = DeviceInitialization(devName)

        if newMethod.name == 'self':
          workingInitializations[devName.upper()].SetCall(newMethod)          
        else:
          workingInitializations[devName.upper()].AppendMethod(newMethod)
      except:
        print(callId)
        print(callBody)
        input("Error in Device Initializations")
        raise

    implementation = regEx.GET_CALLS.sub('',implementation) 
    for match in regEx.GET_PROPERTY_CALL.finditer(implementation):
      devName = match[1].strip('.')
      if devName.upper() not in workingInitializations:
          workingInitializations[devName.upper()] = DeviceInitialization(devName)

      workingInitializations[devName.upper()].AppendProperty(VarAssignment().fromPropertyMatch(match))
    implementation = regEx.GET_PROPERTY_CALL.sub('',implementation)

    for initDevName, init in workingInitializations.items():
      if initDevName in projectKeyedDevices:
        currDevice = projectKeyedDevices[initDevName]

        self.devices.add(currDevice)

        if currDevice.initialization == None:
          currDevice.initialization = init
        else:
          currDevice.initialization.MergeInit(init)    
    
    return self
  
  def Merge(self, other: DeviceInitializations):
    if not isinstance(other, DeviceInitializations):
      raise TypeError(f"Expected DeviceInitializations, got {type(other)}")

    
    for device in other.devices:
      if device not in self.devices:
        self.devices.add(device)
      else:
        existingInit = next((d for d in self.devices if d.name == device.name), None)
        if existingInit:
          existingInit.MergeInit(device.initialization)

    # Update imported initializations
    self.UpdateName(self.name)
  
  @property
  def qualifiedName(self) -> str:
    return self.name
  
  @property
  def unQualifiedName(self) -> str:
    return self.name


  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
  

    
 




  




