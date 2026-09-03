from pathlib import Path
from typing import List,Dict
import re
import copy

from  dacToSim.DataModel.Device.Connections import ConnectionData, ConnectionFiles



class FieldConnection:
  """ Class to collect field connection information """
  def __init__(self, data:ConnectionData, simPort:int=20000):
    self.name : str = data.name
    self.equipIpAddr : str = data.srvIpAddr
    self.equipIpPort : str = data.srvIpPort
    self.simIpPort : str = str(simPort)  # Last 3 characters of the port

class ScadaConnection:
  """ Class to collect SCADA connection information """
  def __init__(self, data:ConnectionData, simPort:int=25000):
    self.name : str = data.name
    self.cliIpAddr : List[str] = data.cliIpAddr  # Multiple IPs for SCADA connections
    self.cliIpPort : int = simPort
    self.srvIpPort : str = data.srvIpPort


class GatewayConnections:
  def __init__(self):
    self.field : List[FieldConnection] = []
    self.scada : List[ScadaConnection] = []

  def AddFieldConnections(self, data:List[ConnectionFiles], startPort:int=20000) -> None:

    """ Add field connections from a list of ConnectionData """
    nextSimIpPort = startPort  # Set the starting port for short IPs
    for connection in sorted(data, key=lambda x: x.connection.name):
      if not connection or not connection.connection: continue
      self.field.append(
        FieldConnection(connection.connection, nextSimIpPort)
      )
      connection.connection.srvIpPort = nextSimIpPort
      
      nextSimIpPort += 1  # Increment for next connection

  def AddScadaConnections(self, data:List[ConnectionFiles], startClientPort:int=25000) -> None:
    """ Add SCADA connections from a list of ConnectionData """
    nextSimIpPort = startClientPort  # Set the starting port for SCADA connections
    for connection in sorted(data, key=lambda x: x.connection.name):
      if not connection or not connection.connection: continue
      
      self.scada.append(
        ScadaConnection(connection.connection, nextSimIpPort)
      )
      connection.connection.cliIpPort = nextSimIpPort
      nextSimIpPort += 1  # Increment for next connection

    
def PadList(original_list, target_count, pad_value):
  # Copy the original list
  new_list = original_list.copy()
  
  # Pad the new list if its length is less than the target count
  while len(new_list) < target_count:
    new_list.append(pad_value)
  
  return new_list










