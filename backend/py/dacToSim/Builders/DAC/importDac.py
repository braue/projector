import math
import copy
from pathlib import Path
from typing import List

from dacToSim.constants.names import folders, fileNames
from dacToSim.constants.names.dacNames import AREAMAP

from dacToSim.DataModel.Profile import Scheme

from dacToSim.DataModel.Project import DacProject, ProjectPaths
from dacToSim.DataModel.Project.DAC.DevDec import getDacDevDec
from dacToSim.DataModel.Project.DAC.DevDef import getDacDevDefs
from dacToSim.DataModel.Project.DAC.Devices import getDacDevices, linkDacConnections
from dacToSim.DataModel.Project.DAC.Connections import getDacClientConnections, getDacServerConnections

from dacToSim.DataModel.Common import VarAssignment
from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Project.DAC.Visualizations import getVisuFiles

from .Initializations import getDacInitializations


def getDacProjects(rootPath: Path, profiles: List[Scheme]) -> List[DacProject]:
  dacProjects: List[DacProject] = []

  for profile in profiles:
    if profile.dac is None:
      continue

    dacProjects.append(_processDacProject(rootPath, profile))

  # Validate in a group to catch any issues with multiple projects
  # This is to ensure that the remote IP addresses are sufficient for the number of clients
  _printDacProjects(dacProjects)
  _validateDacSettings(dacProjects)

  return dacProjects


def _processDacProject(rootPath : Path, profile: Scheme) -> DacProject:
  newProj = DacProject(profile)

  newProj.Name = f'DAC_{profile.schemeName}'
  newProj.Paths = ProjectPaths(rootPath, profile.dac.subFolder)
  newProj.IpAddr = [profile.dac.ipAddr] if isinstance(profile.dac.ipAddr,str) else profile.dac.ipAddr
  newProj.AreaMap = newProj.Paths.areaMap / f"{AREAMAP}.xml"

  newProj.DevDec = getDacDevDec(newProj.Paths.declarations, profile)
  newProj.DevDef = getDacDevDefs(newProj.Paths.definitions, profile)


  newProj.Devices = getDacDevices(newProj)

  newProj.Inits = getDacInitializations(newProj.Paths.initialization, newProj.Devices)


  newProj.Clients = getDacClientConnections(newProj.Paths.clients, profile, "DNP")
  newProj.Servers = getDacServerConnections(newProj.Paths.servers, profile, "DNP")
  newProj.Visualizations = getVisuFiles(newProj.Paths.visualizations)

  linkDacConnections(newProj.Devices, newProj.DevDef, newProj.Clients, newProj.Servers )


  return newProj


def _validateDacSettings(projects: List[DacProject]):
  # Pre-emptive error checking for simulator IP addresses
  simConnectionExceeded : List[DacProject] = []
  for dacProject in projects:
    requiredSimServers = math.ceil(len(dacProject.Clients)/100)

    print(f"Scheme: {dacProject.Scheme.schemeName}; Remote IO required: {requiredSimServers}; "
            f"Addresses Provided: {len(dacProject.Scheme.remote.ipAddr)} ")

    if requiredSimServers > len(dacProject.Scheme.remote.ipAddr):
      simConnectionExceeded.append(dacProject)

  if len(simConnectionExceeded) > 0:
    raise "Insufficient Remote IpAddr provided"
  
  print("")
  

def _printDacProjects(dacProjects: List[DacProject]):
  for dacProject in dacProjects:
    print(f"DAC Project: {dacProject.Name}")
    print(f"  Path: {dacProject.Paths.root}")
    print(f"  IP Addresses: {dacProject.IpAddr}")
    print(f"  Devices: {len(dacProject.Devices)}")
    print(f"  Clients: {len(dacProject.Clients)}")
    print(f"  Servers: {len(dacProject.Servers)}")
    print(f"  Initializations: {len(dacProject.Inits)}")
    print()


