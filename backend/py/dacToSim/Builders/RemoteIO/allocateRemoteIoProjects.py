import math
import copy
from pathlib import Path
from typing import List
from pprint import pprint

from dacToSim.DataModel.Common import VarAssignment
from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Connections import ConnectionFiles
from dacToSim.DataModel.Project import  DacProject, RemProject, ProjectPaths
from dacToSim.DataModel.Project.Initializations import DeviceInitializations
from dacToSim.DataModel.Project.Declarations import DeviceDeclarations


from dacToSim.constants import methodGroups
from dacToSim.constants.projectTypes import REMOTE_IO
from dacToSim.constants.names.simMasterNames import  REMOTE_IO_ID

from .Connections import ConnectionAllocations, allocateSimConnections

def allocateRemoteIoProjects(rootPath : Path, dacProject:DacProject) -> List[RemProject]:
  allocatedConnections = allocateSimConnections(dacProject.Devices)

  numIpAddresses = len(dacProject.Scheme.remote.ipAddr)  if isinstance(dacProject.Scheme.remote.ipAddr, List) else 1

  if numIpAddresses < len(allocatedConnections):
    raise "Insufficient Remote IP Addresses provided for the number of remote projects required."

  newRemoteProjects : List[RemProject] = []

  for i,connections in enumerate(allocatedConnections):
    newRemoteProjects.append(
      _allocateRemoteIoProject(
          rootPath=rootPath,
          dacProject=dacProject,
          index=i + (0 if len(allocatedConnections) == 1 else 1),
          connections=connections
    ))

  return newRemoteProjects

def _allocateRemoteIoProject(rootPath : Path, dacProject:DacProject, index:int, connections:ConnectionAllocations) -> RemProject:
  # Create a working remote IO to populate with the dacProject data
  currProj = RemProject(dacProject.Scheme)

  ioId : str = f'_{index}' if index != 0 else ''

  currProj.Name = REMOTE_IO_ID.format(schemeName=currProj.Scheme.schemeName, index=index)
  currProj.Paths =  ProjectPaths(rootPath, (currProj.Scheme.remote.subFolder + ioId), REMOTE_IO)
  currProj.IpAddr = currProj.Scheme.remote.ipAddr if index == 0 else currProj.Scheme.remote.ipAddr[index - 1]

 
  # Get the interconnect devices from the dacProject
  # The manager pair is required for remote IO projects
  interconnect = [device for device in dacProject.Devices if device in connections.device and "DA_DAC_INTERCONNECT" == device.deviceDeclaration.type.upper()]

  requiredManagers = set()
  for device in interconnect:
    points = device.initialization.getMethodPoint("Manager")
    for point in points.values():
      if point and point.right:
        requiredManagers.add(point.right.upper())

  # DevDef -> deepCopy with reference to original as key
  currProj.Devices = [device for device in dacProject.Devices if device in connections.device or device.name.upper() in requiredManagers]
  currProj.DevDef = dacProject.DevDef


  # need to generalize Connections
  currProj.Clients = connections.scada
  currProj.Servers = connections.field


  for connection in currProj.Clients:
    connection.GetDnpTagLists()  # Ensure tag data is loaded for SCADA connections
  for connection in currProj.Servers:
    connection.GetDnpTagLists()  # Ensure tag data is loaded for field connections


  currProj.DevDec = [_copyDeviceDeclarations(currProj.Devices, devDecFile) for devDecFile in dacProject.DevDec]
  currProj.Inits =  [_copyInit(currProj.Devices, init) for init in dacProject.Inits]

  print(f"  Remote IO Project: {currProj.Name}")
  print(f"    Path: {currProj.Paths.path}")
  for init in currProj.Inits:
    print(f"    Initialization: {init.name} with {len(init.devices)} devices")
 

  # With the new project populated create a deep copy of the project
  # to ensure no references to the original project
  newProj = copy.deepcopy(currProj)

  # Clean the device connections to ensure they are valid
  _cleanDeviceConnections(newProj.Devices, newProj.Clients, newProj.Servers)

  _setInterconnectLocalDacName(dacProject.Devices, newProj.Devices)

  newProj.Gateway.AddFieldConnections(newProj.Servers, 20000)  # Start at port 20000 for field connections
  newProj.Gateway.AddScadaConnections(newProj.Clients, 25000)  # Start at local port 25000 for SCADA connections

  for declaration in newProj.DevDec:
    for device in declaration.declarations:
      device.type = device.type.upper().replace('DA_','SIM_')

  return newProj


def _cleanDeviceConnections(deviceList: List[Device], clients: List[ConnectionFiles], servers: List[ConnectionFiles]):
  # Remove field and scada connections from devices that do not have them
  for device in deviceList:
    if device.field and device.field not in servers:
      device.field = None
    if not device.field:
      _cleanDeviceFieldInit(device)

    if device.scada and device.scada not in clients:
      device.scada = None
    if not device.scada:
      _cleanDeviceScadaInit(device)



def _cleanDeviceScadaInit(device:Device):
  # Remove SCADA init methods if not in scada connection
  methodNames = list(device.initialization.methods.keys())

  for methodName in methodNames:
    if methodName.upper() in methodGroups.SCADA_INIT_METHODS:
      device.initialization.methods.pop(methodName, None)

def _cleanDeviceFieldInit(device:Device):
  # Remove Field init methods if not in field connection
  for methodName, method in device.initialization.methods.items():
    if methodName.upper() in methodGroups.FIELD_INIT_METHODS: continue
    methodInputNames = list(method.inputs.keys())
    for methodInputName in methodInputNames:
      if methodInputName in methodGroups.FIELD_INIT_METHOD_INPUTS:
        method.inputs.pop(methodInputName, None)

   


def _copyDeviceDeclarations(deviceList: List[Device], existing:DeviceDeclarations) -> DeviceDeclarations:
  newDeclarations = DeviceDeclarations()
  newDeclarations.name = existing.name
  # need new initialization for container

  newDeclarations.declarations = [device.deviceDeclaration for device in deviceList if device.deviceDeclaration in existing.declarations]

  return newDeclarations


def _copyInit(newDeviceList: List[Device], existing:DeviceInitializations) -> DeviceInitializations:
  newInit = DeviceInitializations()
  newInit.name = existing.name
  
  newInit.devices = [newDevice for newDevice in newDeviceList if newDevice in existing.devices]

  return newInit


def _setInterconnectLocalDacName(dacDevices:List[Device], devices: List[Device]):
  # Attach DA_Control name to Interconnect objects
  controller : Device = None
  
  for dacDevice in dacDevices:
    if dacDevice.deviceDeclaration.type.upper() == "DA_CONTROL":
      controller = dacDevice
      break

  if controller is None:
    raise Exception("No DA_Control found in DacDevices. Cannot link interconnects.")
  
  if controller.initialization is None or controller.initialization.call is None: 

    raise Exception(f"DA_Control {controller.qualifiedName} is not called. DAC improperly configured.")
  
  controllerName : VarAssignment = None
  for input in controller.initialization.call.inputs.values():
    if input.left.upper() == "NAME":
      controllerName = input
      break

  if controllerName is None:
    raise Exception("DA_Controller does not have a NAME input. DAC improperly configured.")
  
  for device in devices:
    if device.deviceDeclaration.type == "DA_DAC_INTERCONNECT_MANAGER":
      for method in device.initialization.methods.values():
        if method.name.upper() == "INIT":
          # Attach the controller name to the interconnect
          method.appendIO(
            VarAssignment().fromInputs(
              left="LocalDacName",
              right=controllerName.right,
              comment=""
            ),
            ':='
          )
          break
  