from pathlib import Path
from typing import List
import copy

from dacToSim.constants.projectTypes import LOGIC

from .dacProject import DacProject
from .remoteProject import RemProject
from .paths import MasterChildProjectPaths,MasterProjectPaths


from dacToSim.constants.projectTypes import DAC, REMOTE_IO, LOGIC


    
class ProjectSet:
  def __init__(self, dacProject:DacProject|List[DacProject], remProject:RemProject|List[RemProject]):
    if isinstance(dacProject, list):
      self.dac : List[DacProject] = dacProject
    else:
      self.dac : List[DacProject] = [dacProject]
    
    if isinstance(remProject, list):
      self.rem : List[RemProject] = remProject
    else:
      self.rem : List[RemProject] = [remProject]

    self.dac = copy.deepcopy(self.dac)
    self.rem = copy.deepcopy(self.rem)

    self.paths : MasterChildProjectPaths = MasterChildProjectPaths(
      self.dac[0].Paths.root, 
      self.dac[0].Scheme.logic.subFolder, 
      self.dac[0].Scheme.schemeName,
      self.dac[0].Scheme.subSimId,
      LOGIC
    )

  def __repr__(self):
    return f"ProjectSet(DACs: {[dac.Name for dac in self.dac]}, REMs: {[rem.Name for rem in self.rem]})"
  
  def __str__(self):
    return self.__repr__()

  
class MasterProject:
  def __init__(self, rootPath:Path, projectName:str):
    self.sets : List[ProjectSet] = []
    self.paths : MasterProjectPaths = MasterProjectPaths(rootPath, projectName)

  def addProjectSet(self, dacProject:DacProject|List[DacProject], remProject:RemProject|List[RemProject]):
    self.sets.append(ProjectSet(dacProject, remProject))

  def __repr__(self):
    return f"MasterProject(Sets: {len(self.sets)})"
  
  def __str__(self):
    return self.__repr__()
    
