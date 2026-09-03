from pathlib import Path
from typing import List,Dict
import re
import copy


from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Connections import ConnectionFiles


from dacToSim.DataModel.Project.Definitions import DeviceDefinitions
from dacToSim.DataModel.Project.Declarations import DeviceDeclarations
from dacToSim.DataModel.Project.Initializations import DeviceInitializations
from dacToSim.DataModel.Common import FileData


from dacToSim.DataModel.Profile import Scheme


from .paths import ProjectPaths


class DacProject:
  def __init__(self, scheme:Scheme):
    self.Scheme : Scheme = scheme

    self.Name : str = scheme.schemeName
    self.Paths : ProjectPaths
    self.IpAddr : List[str] = scheme.dac.ipAddr
    self.AreaMap : Path
    self.DevDec : List[DeviceDeclarations]
    self.DevDef : List[DeviceDefinitions]
    self.Devices : List[Device]
    self.Inits : List[DeviceInitializations]
    self.Clients : List[ConnectionFiles]
    self.Servers : List[ConnectionFiles]
    self.Visualizations : List[FileData] = []

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result

  def __repr__(self):
    return f"DacProject(Name: {self.Name}, Scheme: {self.Scheme.schemeName})"
  
  def __str__(self):
    return self.__repr__()