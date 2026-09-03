from __future__ import annotations

from typing import List,Literal
import re


from dacToSim.constants.projectTypes import REMOTE_IO

from dacToSim.DataModel.Common import VarAssignment, Method
from dacToSim.DataModel.Device import Device

from dacToSim.DataModel.FileTemplates import programTemplate as template



from dacToSim.DataModel.Profile import Scheme

from dacToSim.DataModel.Converters import getDeviceRules as getConversionDeviceRules
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule

from dacToSim.DataModel.Project.Initializations import DeviceInitializations

TYPE_ORDER = [
  "CONTROL",
  "DAC_INTERCONNECT_MANAGER",
  "DAC_INTERCONNECT",
  "SUB_TRANSFORMER",
  "SUB_MAIN",
  "SUB_TIE",
  "SUB_BUS",
  "FDR",
  "PSEUDO_BKR",
  "BKR",
  "REC",
  "DUAL_SW",
  "SW",
  "MANSW",
  "DG",
  "CAP",
  "REG"
]

def typePriority(device:Device) -> str:
  dtype = device.deviceDeclaration.type.upper()
  for idx, t in enumerate(TYPE_ORDER):
    if t in dtype:
      return f"{idx:02d}_{device.deviceDeclaration.name}"
  return f"{len(TYPE_ORDER):02d}_{device.deviceDeclaration.name}"   # If not found, sort to the end


def buildInitialization(data:DeviceInitializations, scheme:Scheme, projectType:str=REMOTE_IO) -> str:
    deviceInitBuilder = _buildDeviceInitialization(scheme, projectType)

    body = []
    for device in sorted(data.devices, key=typePriority):
      deviceBody = deviceInitBuilder.buildDevice(device)
      if deviceBody:
        body.append(deviceBody)
    if body:
      bodyTxt = "\n\n".join(body)
    else:
      bodyTxt = ""

    contents = template.format(
        pouName=data.name,
        decl='',
        impl=bodyTxt
      )
                            
    return re.sub(r'\(\s*\)', '()', contents, re.DOTALL)


class _buildDeviceInitialization:
  def __init__(self, scheme:Scheme, projectType:str=REMOTE_IO):
    self.scheme = scheme
    self.projectType = projectType

  def _buildLine(self, old:VarAssignment,new:VarAssignment, assignment : Literal[":=","=>"], currDevice:Device) -> str:
    if callable(new.right):
      right = new.right(old, currDevice, self.scheme, self.projectType)
      if right:
        return f"{new.left} {assignment} {right}"
      else:
        return None
    if old and old.right:
      return f"{new.left} {assignment} {old.right}"
    elif new.right is None:
      return None
    else:
      return f"{new.left} {assignment} {new.right}"



  def _buildCall(self, device:Device, callParams:Method, filters:List[VarAssignment]) -> List[str]:
    if not callParams or not filters:
      print(f"Device {device.deviceDeclaration.qualifiedName} has no call parameters or filters.")
      return None
    
    contents = []
    
    for filter in filters:
      if filter.left.upper() in callParams.outputs:
        param = callParams.outputs[filter.left.upper()]
        assignment = '=>'
      elif filter.left.upper() in callParams.inputs:
        param = callParams.inputs[filter.left.upper()]
        assignment = ':=' 
      else:
        param = None
        assignment = ':='

      newLine= self._buildLine(param, filter, assignment, device)
      if newLine is None:
        continue
      contents.append(newLine)

    # Provide contextual formatting for the call parameters
    for i, line in enumerate(contents):
      contents[i] = f"\t{contents[i].strip()}"
      if i < len(contents) - 1:
        contents[i] += ','

    return contents
  

    

  def buildDevice(self, device:Device) -> str:
    
    if not device.initialization:
      print(f"Device {device.deviceDeclaration.qualifiedName} has no initialization data.")
      return ""
    
    #print(f"Building initialization for device {device.deviceDeclaration.qualifiedName} of type {device.deviceDeclaration.type}.")
    
    inits = device.initialization
    deviceRules : DeviceRules = getConversionDeviceRules(device.deviceDeclaration, self.projectType)

    contents = []
    #print(f"Device rules for {device.deviceDeclaration.qualifiedName}: {len(deviceRules.methods)} methods, {len(deviceRules.properties)} properties, call: {deviceRules.call}")


    if inits.call and deviceRules.call:
      body = self._processCall(device, deviceRules.call)
      if body:
        contents.append(body)
      
    for method in deviceRules.methods:
      body = self._processMethod(device, method)
      if body:
        contents.append(body)

    for property in deviceRules.properties:
      body = self._processProperty(device, property)
      if body:
        contents.append(body)
      
    return '\n'.join(contents) if contents else None
  
  def _processCall(self, device:Device, deviceRule:DeviceRule) -> str:
    contents = []
    inits = device.initialization
    
    contents.append(f"{device.deviceDeclaration.unQualifiedName}(")
    contents.extend(
      self._buildCall(device, inits.call, deviceRule.parameters)
    )
    contents.append(");")

    return "\n".join(contents)

  
  def _processMethod(self, device:Device, deviceRule:DeviceRule) -> str:
    contents = []
    inits = device.initialization
    try:
      if deviceRule.lookupName.upper() == 'SELF':
        methodCall = inits.call
      elif deviceRule.lookupName.upper() in inits.methods:
        methodCall = inits.methods[deviceRule.lookupName.upper()]
      elif deviceRule.name.upper() in inits.methods:
        methodCall = inits.methods[deviceRule.name.upper()]
      else:
        return ""
      
    except KeyError:
      return ""

    contents.append(f"{device.deviceDeclaration.unQualifiedName}.{deviceRule.name}(")
    contents.extend(
      self._buildCall(device, methodCall, deviceRule.parameters)
    )
    contents.append(");")

    return "\n".join(contents)



  def _processProperty(self, device:Device, deviceRule : DeviceRule) -> str:
    contents = []

    inits = device.initialization
    
    propertyRule = deviceRule.parameters
    try:
      param = inits.properties[deviceRule.lookupName]
      assignment = ':='
    except KeyError:
      param = None
      assignment = ':='

    newLine = self._buildLine(param, propertyRule, assignment, device)
    if newLine is None:
      return ""
    contents.append(f"{device.deviceDeclaration.qualifiedName}.{newLine};")

    return "\n".join(contents)