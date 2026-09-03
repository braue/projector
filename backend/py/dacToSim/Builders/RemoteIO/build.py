from pathlib import Path
from typing import List

from dacToSim.constants.names import folders, fileNames
from dacToSim.constants.projectTypes import REMOTE_IO
from dacToSim.constants.names import simRemoteIoNames as patterns
from dacToSim.common import writeFile

from dacToSim.DataModel.Project import DacProject, RemProject
from dacToSim.DataModel.Project.Libraries import buildLibrary

from dacToSim.SpecialFiles.Backplane import buildBackplaneTail as buildRemoteIoBackplane
from dacToSim.SpecialFiles.SystemTime import writeRemoteIOSystemTime

from .Declarations import buildDeviceDeclaration
from .Definitions import buildDeviceDefinitions
from .Initializations import buildInitialization
from .allocateRemoteIoProjects import allocateRemoteIoProjects

from dacToSim.Builders.RemoteIO.Connections import writeRedundancyPous

def buildRemoteIoProject(rootPath:Path, dacProject:DacProject) -> List[RemProject]:
  remoteProjects = allocateRemoteIoProjects(rootPath, dacProject)
  # Space Reserved for future use, if needed

  return remoteProjects

    
def writeRemoteIoProjectFiles(remoteProjects:List[RemProject]):  
  for remoteProject in remoteProjects:
    
    for devDec in remoteProject.DevDec:
      for dev in devDec.declarations:
        if not dev.type.endswith("_REMOTE"):
          dev.type = f"{dev.type}_REMOTE"

      writeFile(
        remoteProject.Paths.declarations / f"{devDec.name}.xml",
        buildDeviceDeclaration(devDec),
        True
      )

    for devDef in remoteProject.DevDef:
      writeFile(
        remoteProject.Paths.definitions / f"{devDef.name}.xml",
        buildDeviceDefinitions(devDef),
        True
      )

    for client in remoteProject.Clients:
      client.convertToClient(
        path=remoteProject.Paths.clients,
        schemeName=remoteProject.Scheme.schemeName,
        serverIpAddr=remoteProject.Scheme.dac.ipAddr,
        integrityPollPeriod=5000,  # Default integrity poll period
        eventPollPeriod=1000  # Default event poll period
      )

    writeRedundancyPous(
      remoteProject.Paths.logicPath,
      remoteProject.Paths.pouPath,
      remoteProject.Scheme.dac.ipAddr,
      remoteProject.Clients
    )
         
    for server in remoteProject.Servers:
      server.convertToServer(
        path=remoteProject.Paths.servers,
        dacIpAddr=remoteProject.Scheme.dac.ipAddr,
        clientIpAddr='192.168.254.1',
      )

    for init in remoteProject.Inits:
      writeFile(
        remoteProject.Paths.initialization / f"{init.name}.xml",
        buildInitialization(init, remoteProject.Scheme, REMOTE_IO),
        True
      )

    writeFile(
      remoteProject.Paths.initialization / f'{patterns.INIT_REMOTE_IO}.xml',
      buildRemoteIoBackplane(remoteProject.Scheme, remoteProject.IpAddr),
      True
    )

    for library in remoteProject.Libraries:
      writeFile(
        remoteProject.Paths.logicPath / folders.LIBRARIES / library.fileName,
        buildLibrary(library),
        True
      )

    writeRemoteIOSystemTime(remoteProject.Paths.system)