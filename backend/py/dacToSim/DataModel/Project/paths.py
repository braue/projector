from typing import List

from pathlib import Path
import copy


from dacToSim.constants.names import folders, fileNames
from dacToSim.constants.projectTypes import DAC, REMOTE_IO, LOGIC


class ProjectPaths:
  def __init__(self, rootPath:Path, projectName:str,type:str=DAC):
    self.root : Path = rootPath
    self.projectName :str = projectName

    if type == DAC:
      self.connectionsFolderName = folders.CONNECTIONS
      self.logicFolderName = folders.DAC_LOGIC
      
    elif type == REMOTE_IO:
      self.connectionsFolderName = folders.CONNECTIONS
      self.logicFolderName = folders.SIM_LOGIC
    elif type == LOGIC:
      self.connectionsFolderName = folders.CONNECTIONS
      self.logicFolderName = folders.SIM_LOGIC
      
    else:
      raise ValueError(f"Unknown project type: {type}")
    
  @property
  def path(self) -> Path:
    return self.root / self.projectName
  
  @property
  def projectPath(self) -> Path:
    return self.path / folders.DEVICE
  
  @property
  def system(self) -> Path:
    return self.projectPath / folders.SYSTEM
  
  @property
  def logicPath(self) -> Path:
    return self.projectPath / self.logicFolderName
  
  @property
  def pouPath(self) -> Path:
    return self.path / folders.POU
  
  @property
  def areaMap(self) -> Path:
    return self.logicPath
  
  @property
  def declarations(self) -> Path:
    return self.logicPath
  
  @property
  def definitions(self) -> Path:
    return self.logicPath / folders.DEVICE_DEFINITION
  
  @property
  def initialization(self) -> Path:
    return self.logicPath / folders.INITIALIZATIONS
  
  @property
  def clients(self) -> Path:
    return self.projectPath / self.connectionsFolderName
  @property
  def servers(self) -> Path:
    return self.projectPath / self.connectionsFolderName
  
  @property
  def visualizations(self) -> List[Path]:
    return [self.projectPath / folder for folder in folders.VISUALIZATIONS]

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
    
  def folderReport(self) -> str:
    """
    Returns a string representation of the folder structure for the project,
    using relative paths from projectPath and prepending with %dacSubFolder%.
    """
    def rel(p):
        return rf"%dacSubFolder%\{p.relative_to(self.path)}" if isinstance(p, Path) else p

    report = f"Project: {self.projectName}\n"
    report += f"Root Path: {self.root}\n"
    report += f"Project Path: {rel(self.projectPath)}\n"
    report += f"Logic Path: {rel(self.logicPath)}\n"
    report += f"POU Path: {rel(self.pouPath)}\n"
    report += f"Area Map: {rel(self.areaMap)}\n"
    report += f"Declarations: {rel(self.declarations)}\n"
    report += f"Definitions: {rel(self.definitions)}\n"
    report += f"Initialization: {rel(self.initialization)}\n"
    report += f"Clients: {rel(self.clients)}\n"
    report += f"Servers: {rel(self.servers)}\n"
    report += f"Visualizations: {',\n\t'.join(rel(v) for v in self.visualizations)}\n"
    return report
  

class MasterProjectPaths:
  def __init__(self, rootPath:Path, projectName:str):
    self.root : Path = rootPath
    self.projectName :str = projectName

    self.logicFolderName = folders.SIM_LOGIC
    self.connectionsFolderName = folders.CONNECTIONS

  @property
  def path(self) -> Path:
    return self.root / self.projectName
  
  @property
  def projectPath(self) -> Path:
    return self.path / folders.DEVICE
  
  @property
  def system(self) -> Path:
    return self.projectPath / folders.SYSTEM
  
  @property
  def logicPath(self) -> Path:
    return self.projectPath / folders.SIM_LOGIC
  
  @property
  def pouPath(self) -> Path:
    return self.path / folders.POU
  
  @property
  def areaMap(self) -> Path:
    return self.logicPath / folders.AREA_MAP
  
  @property
  def declarations(self) -> Path:
    return self.logicPath / folders.DEVICE_DECLARATION
  
  @property
  def definitions(self) -> Path:
    return self.logicPath / folders.DEVICE_DEFINITION
  
  @property
  def initialization(self) -> Path:
    return self.logicPath / folders.INITIALIZATIONS
  
  @property
  def libraries(self) -> Path:
    return self.logicPath / folders.LIBRARIES
  
  @property
  def visualizations(self) -> Path:
    return self.projectPath / folders.MASTER_VISUALIZATIONS
  
  @property
  def gateway(self) -> Path:
    return self.logicPath
  
  @property
  def clients(self) -> Path:
    return self.projectPath / self.connectionsFolderName
  @property
  def servers(self) -> Path:
    return self.projectPath / self.connectionsFolderName
  
  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
  
  def folderReport(self) -> str:
    """
    Returns a string representation of the folder structure for the project,
    using relative paths from projectPath and prepending with %dacSubFolder%.
    """
    def rel(p):
        return rf"%dacSubFolder%\{p.relative_to(self.path)}" if isinstance(p, Path) else p

    report = f"Master Project: {self.projectName}\n"
    report += f"Root Path: {self.root}\n"
    report += f"Project Path: {rel(self.projectPath)}\n"
    report += f"Logic Path: {rel(self.logicPath)}\n"
    report += f"POU Path: {rel(self.pouPath)}\n"
    report += f"Area Map: {rel(self.areaMap)}\n"
    report += f"Declarations: {rel(self.declarations)}\n"
    report += f"Definitions: {rel(self.definitions)}\n"
    report += f"Initialization: {rel(self.initialization)}\n"
    report += f"Libraries: {rel(self.libraries)}\n"
    report += f"Visualizations: {rel(self.visualizations)}\n"
    report += f"Gateway: {rel(self.gateway)}\n"
    report += f"Clients: {rel(self.clients)}\n"
    report += f"Servers: {rel(self.servers)}\n"
    return report
  

  
class MasterChildProjectPaths:
  def __init__(self, rootPath:Path, projectName:str,dacId:str,simId:str,type:str=DAC):
    self.root : Path = rootPath
    self.projectName :str = projectName
    self.dacId : str = dacId
    self.simId : str = simId
    self.initId = f"{simId}_{dacId}"

    if type == DAC:
      self.connectionsFolderName = folders.CONNECTIONS
      self.logicFolderName = folders.DAC_LOGIC
      
    elif type == REMOTE_IO:
      self.connectionsFolderName = folders.CONNECTIONS
      self.logicFolderName = folders.SIM_LOGIC
    elif type == LOGIC:
      self.connectionsFolderName = folders.CONNECTIONS
      self.logicFolderName = folders.SIM_LOGIC
      
    else:
      raise ValueError(f"Unknown project type: {type}")
    
  @property
  def path(self) -> Path:
    return self.root / self.projectName
  
  @property
  def projectPath(self) -> Path:
    return self.path / folders.DEVICE
  
  @property
  def system(self) -> Path:
    return self.projectPath / folders.SYSTEM
  
  @property
  def logicPath(self) -> Path:
    return self.projectPath / self.logicFolderName
  
  @property
  def pouPath(self) -> Path:
    return self.path / folders.POU
  
  @property
  def areaMap(self) -> Path:
    return self.logicPath / self.initId / folders.AREA_MAP
  
  @property
  def declarations(self) -> Path:
    return self.logicPath / self.initId / folders.DEVICE_DECLARATION
  
  @property
  def definitions(self) -> Path:
    return self.logicPath / self.initId / folders.DEVICE_DEFINITION
  
  @property
  def initialization(self) -> Path:
    return self.logicPath / self.initId / folders.INITIALIZATIONS
  
  @property
  def gateway(self) -> Path:
    return self.logicPath / self.initId / folders.GATEWAY
  
  @property
  def remoteIO(self) -> Path:
    return self.logicPath / self.initId / folders.REMOTEIO
  
  @property
  def clients(self) -> Path:
    return self.projectPath / self.connectionsFolderName / self.initId
  @property
  def servers(self) -> Path:
    return self.projectPath / self.connectionsFolderName / self.initId

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
  
  def folderReport(self) -> str:
    """
    Returns a string representation of the folder structure for the project,
    using relative paths from projectPath and prepending with %dacSubFolder%.
    """
    def rel(p):
        return rf"%dacSubFolder%\{p.relative_to(self.path)}" if isinstance(p, Path) else p
    report = f"Child Project: {self.projectName}\n"
    report += f"Root Path: {self.root}\n"
    report += f"Project Path: {rel(self.projectPath)}\n"
    report += f"Logic Path: {rel(self.logicPath)}\n"
    report += f"POU Path: {rel(self.pouPath)}\n"
    report += f"Area Map: {rel(self.areaMap)}\n"
    report += f"Declarations: {rel(self.declarations)}\n"
    report += f"Definitions: {rel(self.definitions)}\n"
    report += f"Initialization: {rel(self.initialization)}\n"
    report += f"Gateway: {rel(self.gateway)}\n"
    report += f"Remote IO: {rel(self.remoteIO)}\n"
    report += f"Clients: {rel(self.clients)}\n"
    report += f"Servers: {rel(self.servers)}\n"
    return report