from pathlib import Path
from typing import List,Dict
import re
import copy


from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Connections import ConnectionFiles


from dacToSim.DataModel.Project.Definitions import DeviceDefinitions
from dacToSim.DataModel.Project.Declarations import DeviceDeclarations
from dacToSim.DataModel.Project.Initializations import DeviceInitializations
from dacToSim.DataModel.Project.Gateway.gateway import GatewayConnections

from dacToSim.DataModel.Profile import Scheme


from .Libraries import Library, SIM_LIBRARY

from .paths import ProjectPaths


class RemProject:
  def __init__(self, scheme:Scheme):

    self.Scheme : Scheme = scheme

    self.Name : str
    self.Paths : ProjectPaths
    self.IpAddr : str
    
    self.Devices : List[Device]

    self.DevDef : List[DeviceDefinitions]
    self.DevDec : List[DeviceDeclarations]
    
    
    self.Inits : List[DeviceInitializations]
    self.Clients : List[ConnectionFiles]
    self.Servers : List[ConnectionFiles]

    self.Gateway : GatewayConnections = GatewayConnections()

    self.Libraries  : List[Library] = [SIM_LIBRARY]

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result

  def printReport(self):
    print(f"Remote Project: {self.Name}")
    print(f"  Path: {self.Paths.root}")
    print(f"  IP Address: {self.IpAddr}")
    print(f"  Number of Devices: {len(self.Devices)}")
    for device in self.Devices:
      device.printReport()
    print(f"  Number of Clients: {len(self.Clients)}")
    #for client in self.Clients:
    #  client.printReport()
    print(f"  Number of Servers: {len(self.Servers)}")
    #for server in self.Servers:
    #  server.printReport()
    print(f"  Number of Gateways Field Connections: {len(self.Gateway.field)}")
    print(f"  Number of Gateways Server Connections: {len(self.Gateway.scada)}")
    print(f"  Number of Libraries: {len(self.Libraries)}")
    for lib in self.Libraries:
      print(f"    Library: {lib.name} Version: {lib.version}")
    print(f"  Number of Device Definitions: {len(self.DevDef)}")
    print(f"  Number of Device Declarations: {len(self.DevDec)}")
    print(f"  Number of Device Initializations: {len(self.Inits)}")
    for init in self.Inits:
      print(f"    Device Initialization: {init.name}")
      print(f"      Properties: {len(init.devices)}")


