from __future__ import annotations

from pathlib import Path
from typing import List,Dict,Literal
import re
import copy

from dacToSim.DataModel.Common import VarAssignment, Method

from dacToSim.common import stringReplaceIgnoreCase





def toList(v) -> List:
  if not isinstance(v,List) and v:
    v = [v]
  
  return v


class DeviceInitialization:
  def __init__(self, name : str):
    self.name = name
    self.call : Method = None
    self.methods : Dict[str,Method] = {}
    self.properties : Dict[str,VarAssignment] = {}

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result


  def SetCall(self, call:Method):
    if self.call:
      raise Exception(f"Self Call Already Exists")
    self.call = call

  def AppendMethod(self, method:Method):
    if method.name.upper() in self.methods:
      raise Exception(f"{method.name}: Already Exists") 
    self.methods[method.name.upper()] = method

  def AppendProperty(self, property:VarAssignment):
    if property.left.upper() in self.properties:
      raise Exception(f"{property.left}:  Already Exists")
    self.properties[property.left.upper()] = property

  def getMethodPoint(self,pointName:str|List[str],methodId:str|List[str]="") -> Dict[str,VarAssignment]:
    methodId = toList(methodId)
    pointName = toList(pointName)
    
    print(f"Raw: {methodId} ")
    if methodId:
      methodId = [x.upper() for x in methodId]
    else:
      methodId = [x.upper() for x in self.methods.keys()]

    pointValues : Dict[str,VarAssignment] = {}
    print(f"Check PointName(s): {pointName}")
    if methodId and len(methodId) > 0:

      for methodName in methodId:
        print(f"Current MethodName: {methodName} ")
        pointValue : VarAssignment = None
        if methodName in self.methods:
          pointValue = self.methods[methodName].getPoint(pointName)
        if pointValue: pointValues[methodName] = pointValue
    else:
      for methodName, method in self.methods.items():
        pointValue = method.getPoint(pointName)
        if pointValue: pointValues[methodName] = pointValue
            
    return pointValues
  
  def getMethodPoint(self,pointName:str|List[str],methodId:str|List[str]="") -> Dict[str,VarAssignment]:
    methods : List[Method] = []
    if methodId:
      methodId = toList(methodId)
      for method in [x.upper() for x in methodId]:
        if method in self.methods:
          methods.append(self.methods[method])
        elif method == "SELF":
          if self.call:
            methods.append(self.call)
    else:
      methods.extend([x for x in self.methods.values()])
      if self.call:
        methods.append(self.call)

    pointName = toList(pointName)
    pointValues : Dict[str,VarAssignment] = {}
    for method in methods:
      pointValue : VarAssignment = method.getPoint(pointName)
      
      if pointValue: 
        pointValues[method.name.upper()] = pointValue          
    return pointValues


  def UpdateVars(self, varNameOld:str, varDataNew:str):
    for method in self.methods.values():
      method.UpdateVars(varNameOld, varDataNew)
    
    if self.call:
      self.call.UpdateVars(varNameOld, varDataNew)

    for property in self.properties.values():
      property.right = stringReplaceIgnoreCase(property.right, varNameOld, varDataNew)


  def MergeInit(self, other:DeviceInitialization):
    if other.call:
      if self.call is None:
        self.call = other.call
      else:
        print(f"Call {other.call.name} already exists in {self.name}. Merging.")

    for methodName, method in other.methods.items():
      if methodName not in self.methods:
        self.methods[methodName] = method
      else:
        print(f"Method {methodName} already exists in {self.name}. Merging.")


    for propName, prop in other.properties.items():
      if propName not in self.properties:
        self.properties[propName] = prop
      else:
        print(f"Property {propName} already exists in {self.name}. Merging.")
        
