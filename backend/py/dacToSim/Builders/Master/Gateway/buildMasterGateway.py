
from typing import List, Dict, Set

from dacToSim.Builders.Master.Gateway.gatewayPou import GatewayPou
from .template import masterTemplate as template


class RedundantScadaConnection:
    def __init__(self, priPou: str, secPou: str, tagName: str):
        self.PriTag = f"{priPou}.{tagName}"
        self.SecTag = f"{secPou}.{tagName}"


def buildMasterGateway(gateways: List[GatewayPou], ipAddr: str, redundantScada:List[RedundantScadaConnection] = None) -> str:
    ''' Build the master gateway POU file content '''
    # This function would generate the XML content for the master gateway
    # based on the provided gateways and IP address.
    # Placeholder implementation:

    MasterIpVarName = "Head_SIM_IP"
    decHeadIp = f"{MasterIpVarName}	: IpAdrStr :=	'{ipAddr[0]}';"

    maxDacIps = 0

    decDacIps : Dict[str,Dict[str]] = {}
    decSimIps : Dict[str,Dict[str]] = {}
    decGateways = []
    

    # Convert to set to avoid duplicates
    for gateway in gateways:
      decGateways.append(f"\t{gateway.instanceName} : {gateway.pouName};")
      addUniqueIps(gateway.dacIpVarName, gateway.dacIP, decDacIps)
      addUniqueIps(gateway.simIpVarName, gateway.simIP, decSimIps)

    textDecDacIps = []
    for varName, ips in decDacIps.items():
      textDecDacIps.append(f"\t{varName}	: ARRAY[1..{len(ips)}] OF IpAdrStr :=	{[ip for ip in ips.keys()]};")

      if len(ips.keys()) > maxDacIps:
        maxDacIps = len(ips.keys())

    decMaxDacs = f"\tMaxDacs : INT := {maxDacIps};"
    decSimPortPreFix = f"\tsimPortPreFix : ARRAY[1..MaxDacs] OF STRING(2) := [{', '.join([f"'{i+20:02}'" for i in range(maxDacIps)])}];"
      

    textDecSimIps = []
    for varName, ips in decSimIps.items():
      textDecSimIps.append(f"\t{varName}	: ARRAY[1..{len(ips)}] OF IpAdrStr :=	{[ip for ip in ips.keys()]};")

    # Generate the gateway calls
    implGatewayCalls = []
    for gateway in gateways:
      checkIp = "" 
      if isinstance(gateway.simIP, str):
        checkIp = gateway.simIP
      elif isinstance(gateway.simIP, List):
        checkIp = gateway.simIP[0] if gateway.simIP else ""

      if not checkIp:
        raise ValueError(f"Gateway {gateway.instanceName} has no SIM IP address defined.")

      indexSimIp = 0
      simIps = decSimIps[gateway.simIpVarName]
      for i, ip in enumerate(simIps.keys()):
        if ip == checkIp:
          indexSimIp = i + 1
          break
      if indexSimIp == 0:
        raise ValueError(f"Could not find index for SIM IP {gateway.simIP} in {simIps.keys()}")
  
      implGatewayCalls.append(f"\t{gateway.instanceName}(\tDAC_IP:=\t{gateway.dacIpVarName},\tsimPortPrefix:=\tsimPortPreFix,\tSIM_IP:=\t{gateway.simIpVarName}[{indexSimIp}]\t);")

  
    return template.format(
      decDacIps="\n".join(textDecDacIps),
      decSimIps="\n".join(textDecSimIps),
      decHeadIp=decHeadIp,
      decSimPortPreFix=decSimPortPreFix,
      decGateway="\n".join(decGateways),
      maxDacs=decMaxDacs,
      implRedundantConnections="",
      implGatewayCalls="\n".join(implGatewayCalls)
    )


def addUniqueIps(varName:str, ipAddr : str|List[str], collection: Dict[str, Dict[str, str]]):
  if varName not in collection:
    collection[varName] = {}
  if isinstance(ipAddr,str):
    collection[varName][ipAddr] = ipAddr
  elif isinstance(ipAddr, List):
    for ip in ipAddr:
      collection[varName][ip] = ip
  else:
    raise TypeError(f"Expected str or List[str] for ipAddr, got {type(ipAddr)}")