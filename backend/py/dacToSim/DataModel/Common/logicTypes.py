from __future__ import annotations
from pathlib import Path
from typing import List,Dict,Literal,Tuple,Callable

import re
from re import Match
import copy
from dacToSim.common import stringReplaceIgnoreCase

from pprint import pprint

def toList(v) -> List:
  if not isinstance(v,List):
    v = [v]
  
  return v


class VarAssignment:
  def __init__(self):
    self.left:str = ""
    self.right:str|Callable[[], str] = "" # This can be a string or a function that returns a string. Expected inputs are (oldVar:VarAssignment, device:Device, scheme:Scheme, projectType:str)
    self.comment:str = ""

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result

  def fromInputs(self, left:str,right:str,comment:str) -> VarAssignment:
    self.left=left
    self.right=right
    self.comment=comment
    self._sanitizeTypes()

    return self

  def fromParameterMatch(self, match:re.Match) -> VarAssignment:
    self.left= match.group(1),
    self.right= match.group(3),
    self.comment= ""
    self._sanitizeTypes()

    return self
  
  def fromPropertyMatch(self, match:re.Match)  -> VarAssignment:
    self.left= match.group(2),
    self.right= match.group(3),
    self.comment= ""
    self._sanitizeTypes()

    return self
  
  def _sanitizeTypes(self):
    if not isinstance(self.left, str):
      self.left = cleanGroup(self.left)

    if not isinstance(self.right, str) and not callable(self.right):
      self.right = cleanGroup(self.right)

    if not isinstance(self.comment, str):
      self.comment = cleanGroup(self.comment)
      
  def write(self,assignment:Literal[":=","=>"] = ":=", padding=""):
    return f"{padding}{self.left}\t{assignment}\t{self.right}"
  

  

def cleanGroup(group):
  if not group:
    return ''
  elif isinstance(group,(tuple,list)):
    return str(''.join(str(g) for g in group if g))
  else:
    return str(group)
    




def getCommentStr(value:str):
  if not value:
    return ""
  if "\n" in value:
    return f" (* {value} *)"
  else:
    return f" // {value}"
  


from dacToSim.DataModel.Common import regEx


class Method:
  def __init__(self):
    self.name : str
    self.inputs : Dict[str, VarAssignment]
    self.outputs : Dict[str, VarAssignment]

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result


  def fromList(self,name:str,inputs:List[VarAssignment],outputs:List[VarAssignment]):
    self.name = name
    self.inputs = {}
    for input in inputs:
      self.inputs[input.left.upper()] = input

    self.outputs = {}
    for output in outputs:
      self.outputs[output.left.upper()] = output

    return self
  
  def fromNameBody(self, name:str, body:str):
    self.name = name
    (self.inputs, self.outputs) = self._parseIo(body)

    return self
  

  def appendIO(self, io:VarAssignment, assignment:Literal[":=","=>"]):
    if assignment == ':=':
      self.inputs[io.left.upper()] = io
    elif assignment == '=>':
      self.outputs[io.left.upper()] = io
    else:
      raise ValueError(f"Invalid assignment type: {assignment}. Expected ':=' or '=>'.")


  def _parseIo(self, text:str) -> Tuple[Dict[VarAssignment],Dict[VarAssignment]]:
    inputs : Dict[VarAssignment] = {}
    outputs : Dict[VarAssignment] = {}


    for match in regEx.GET_PARAMETERS_COMMENTS_STRIPPED.finditer(text):
      newAssignment = VarAssignment().fromParameterMatch(match)

      if match[2] == ':=':
        try:  
          inputs[newAssignment.left.upper()] = newAssignment
        except:
          print(type(newAssignment))
          print(newAssignment)
          print(type(newAssignment.left))
          print(newAssignment.left)
          input("Method Parse Error. Press Enter to continue...")
          raise


      elif match[2] == '=>':
        outputs[newAssignment.left.upper()] = newAssignment
    return (inputs, outputs)
  
  def getPoint(self, pointName:str|List[str]) -> VarAssignment:
    pointNames = [x.upper() for x in toList(pointName)]

    for pointName in pointNames:
      if pointName in self.inputs:
        return self.inputs[pointName]
      
      if pointName in self.outputs:
        return self.outputs[pointName]
        
  def UpdateVars(self, varNameOld:str, varNameNew:str):
    for var in self.inputs.values() :
      var.right = stringReplaceIgnoreCase(var.right, varNameOld, varNameNew)

    for var in self.outputs.values() :
      var.right = stringReplaceIgnoreCase(var.right, varNameOld, varNameNew)




