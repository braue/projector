from __future__ import annotations

import re

from dacToSim.DataModel.Common.regEx import GET_DECLARATION
from dacToSim.DataModel.Common import getCommentStr


from typing import List


from dacToSim.constants import regEx

class DeclarationNote:
  def __init__(self, text: str):
    self.text = text

  def __str__(self):
    return f"Note: {self.text}"

  def __repr__(self):
    return f"DeclarationNote(text={self.text})"
  
  def write(self, forceValue:bool = False) -> str:
    return self.text

class Declaration:
  def __init__(self, name:str, type:str, value:str, comment:str = ''):
    self.name = name
    self.type = type
    self.value = value
    self.comment = comment

  def __str__(self):
    return self.write(forceValue=True)
  
  def __repr__(self):
    return f"Declaration(name={self.name}, type={self.type}, value={self.value}, comment={self.comment})"
  
  
  def write(self, forceValue:bool = False) -> str:
    if (forceValue or self.value) and not 'JOIN' in self.type.upper():
      return f"{self.name} : {self.type} := {self.value};{getCommentStr(self.comment)}".strip()
    else:
      return f"{self.name} : {self.type}; {getCommentStr(self.comment)}".strip()


  @staticmethod
  def fromDeclText(text:str) -> Declaration:
    match = GET_DECLARATION.match(text)
    if not match:
      print(f"Invalid declaration format: {text}")
      return None
    
    return Declaration(match.group(1), match.group(2), match.group(3) or '',  '')


class DeclarationGroup:
  def __init__(self, name:str, declarations:List[Declaration]):
    self.name = name
    self.declarations : List[Declaration] = [declaration for declaration in declarations if declaration]
    self.notes : List[DeclarationNote] = []
    if self.declarations and not (isinstance(self.declarations[0], Declaration) or isinstance(self.declarations[0], DeclarationNote)):
      raise ValueError("Declarations must be a list of Declaration objects")

    self.existingVars = {d.name.upper():d for d in self.declarations}

  def __str__(self):
    return self.write(False)
  
  def write(self, forceValues:bool=False) -> str:
    body = []
    if self.notes:
      body.extend([f'{note.write(forceValues)}' for note in self.notes])
    if self.name.upper() == 'LOCAL':
      body.append('VAR')
    else:
      body.append(f'VAR_{self.name.upper()}')

    body.extend([f'\t{d.write(forceValues)}' for d in self.declarations])

    body.append('END_VAR')

    return '\n'.join(body)
    
  def __repr__(self):
    return f"DeclarationGroup(name={self.name}, declarations=\n\t{'\n\t'.join(d.__repr__() for d in self.declarations)}, notes=\n\t{'\n\t'.join(n.__repr__() for n in self.notes)})"
  
  def extend(self, other:DeclarationGroup):
    if self.name.upper() != other.name.upper():
      raise ValueError(f"Cannot extend declaration group '{self.name}' with '{other.name}'")
    
    # Check for duplicates var declarations from IEC-61131 format defined in the other group
    # If not present, add them to the current group 
    incoming_var_names = other.existingVars.keys()
    new_var_names = incoming_var_names - self.existingVars.keys()
    if new_var_names:
      for newName in new_var_names:
        self.append(other.existingVars[newName].write(True))

  def merge(self, other:DeclarationGroup):
    if self.name.upper() != other.name.upper():
      raise ValueError(f"Cannot merge declaration group '{self.name}' with '{other.name}'")
        
    # Update existing vars with the new ones
    # Incoming right side will overwrite the existing ones
    for d in other.declarations:
      if d.name.upper() in self.existingVars:
        self.existingVars[d.name.upper()].value = d.value
        self.existingVars[d.name.upper()].comment = d.comment
      else:
        self.append(d.write(True))

  def appendInput(self, name:str, type:str, value:str='', comment:str='') -> Declaration:
    new : Declaration = Declaration(name, type, value, comment)
    self.append(new.write(True))


  def append(self, declarationLine:str):
    if not declarationLine.strip():
      return
    try:
      incoming_var = Declaration.fromDeclText(declarationLine)
    except Exception as e:
      return
    
    if incoming_var.name.upper() not in self.existingVars:
      self.declarations.append(incoming_var)
      self.existingVars[incoming_var.name.upper()] = incoming_var
    else:
      self.existingVars[incoming_var.name.upper()].value = incoming_var.value
      self.existingVars[incoming_var.name.upper()].comment = incoming_var.comment

  def setNotes(self, notes:List[str]|str):
    if not notes:
      return
    if isinstance(notes, str):
      notes = [notes]

    notes = [f'{note.strip()}' for note in notes]

    self.notes.extend([DeclarationNote(note) for note in notes])



RE_POU_DECL = re.compile(r'<Single Name="TextBlobForSerialisation" Type="string">.*(?:\n.*?)*?<\/Single>', flags=regEx.defaultFlags)
RE_VAR_GROUP = re.compile(r'^\s*VAR(?:_(\w+)|).*\n((.*?\n)*?)END_VAR', flags=regEx.defaultFlags)


def getExistingDeclaration(body:str) -> List[DeclarationGroup]:
  declaration = RE_POU_DECL.search(body)

  groups : List[DeclarationGroup] = []

  for match in RE_VAR_GROUP.finditer(declaration.group(0)):
    groupName = match.group(1) if match.group(1) else "local"
    rawDeclarations = match.group(2).strip().splitlines()
    declarations = [Declaration.fromDeclText(d) for d in rawDeclarations if d.strip()]  # Clean up empty lines
    groups.append(DeclarationGroup(groupName, declarations))

  return groups
