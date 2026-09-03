from dacToSim.DataModel.Profile import Scheme

from .templates import GetHeadBackplane, GetTailBackplane

def buildBackplaneHead( profile:Scheme, simIpVarName:str):
  return GetHeadBackplane(profile.schemeName, simIpVarName, profile.remote.ipAddr)
 
def buildBackplaneTail(profile:Scheme, simIp:str):
  return GetTailBackplane(schemeName=profile.schemeName, simIp=simIp, headIp=profile.logic.ipAddr)
 