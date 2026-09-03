from typing import List


class GatewayPou:
  def __init__(self, name:str, dacName:str, dacIP, simName:str, simIP:str):
    ''' Represents a Gateway POU in the Master project '''
    self.name = name.replace(" ","_")
    self.dacName = dacName.replace(" ","_")
    if not isinstance(dacIP, list):
      self.dacIP : List[str] = [dacIP]
    else:
      self.dacIP : List[str] = dacIP
    self.simName = simName
    self.simIP : str = simIP

  @property
  def pouName(self) -> str:
    return f"{self.simName}_Gateway"
  
  @property
  def instanceName(self) -> str:
    return f"{self.simName}_GW"
  
  @property
  def dacIpVarName(self) -> str:
    return f"{self.dacName}_DAC_IP"
  
  @property
  def simIpVarName(self) -> str:
    return f"{self.name}_SIM_IP"
