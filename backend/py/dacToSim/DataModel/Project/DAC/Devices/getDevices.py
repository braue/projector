from pathlib import Path
from typing import List,Dict,Literal
from pprint import pprint
import re


from dacToSim.constants import regEx
from dacToSim.common import invertDict

from dacToSim.DataModel.Common import VarAssignment

from dacToSim.DataModel.Project.dacProject import DacProject


from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Initialization import DeviceInitialization
from dacToSim.DataModel.Device.Declaration import DeviceDeclaration
from dacToSim.DataModel.Device.Definition import DeviceDefinition
from dacToSim.DataModel.Device.Connections.connections import ConnectionFiles

from dacToSim.DataModel.Project.Definitions import DeviceDefinitions
from dacToSim.DataModel.Project.Declarations import DeviceDeclarations

from dacToSim.DataModel.Common import GetItemFullNameSpace

CLIENT_POINTS : List[str] = [f"pFieldFirst_{x}" for x in ["Bi","Ai","Ao","Cnt"]  ]
SERVER_POINTS : List[str] = [f"pFirst_{x}" for x in ["Bi","Ai","Ao","Cnt"]  ]


RE_GET_MAP_NAME = re.compile(r'ADR\(\s*([^\s.]+)\s*\.\s*([^\s)]+)\s*',regEx.defaultFlags)


def getMappedPouName(init:DeviceInitialization,filter:List[str], suffix:str) -> List[str]:
  results : List[str] = []
  for point in init.getMethodPoint(filter).values():
    match = RE_GET_MAP_NAME.search(point.right)
    if match and match.group(1) not in results:
      if match.group(1).endswith(suffix):
        results.append(match.group(1))
  return results

def getMappedPou(device:Device, filter:List[str], connectionType: Literal["Client","Server"], suffix:str, pous:Dict[str,ConnectionFiles]) -> ConnectionFiles | None:
  pouNames : List[str] = getMappedPouName(device.initialization, filter, suffix)
  if len(pouNames) > 1:
    print(f"{device.name}: Using has {len(pouNames)} {connectionType}s. Corrections required in simulator")

  if not pouNames:
    return None
  elif pouNames[0] in pous:
    return pous[pouNames[0]]
  else:
    return None
    
def getDacDevices(project:DacProject) -> List[Device]:
  devices : List[Device] = []

  for devDec in project.DevDec:
    for dev in devDec.declarations:
      devices.append(Device(dev))
  
  return devices


def getDevicesFromDevDec(devDec:DeviceDeclarations) -> List[Device]:
  devices : List[Device] = []
  declarations : Dict[DeviceDeclaration,List[str]] = invertDict(GetItemFullNameSpace(devDec))
  for dev, devIds in declarations.items():
    devices.append(Device(dev))

  return devices

def linkDacConnections(devices:List[Device],devDefs:List[DeviceDefinitions],clients:List[ConnectionFiles],servers:List[ConnectionFiles]) -> None:
  devDefList = []
  for devDef in devDefs:
    if devDef.definitions:
      devDefList.extend(devDef.definitions)
  keyedDevDef : Dict[str,DeviceDefinition] = GetItemFullNameSpace(devDefList)
  
  keyedClients = { f"{x.connection.name}_DNP":x for x in clients}
  keyedServers = { f"{x.tagMap.name}_DNP":x for x in servers}

  # Get the device initialization. Fully and partially qualified namespace expected to be bound in create
  for device in devices:
    if not device.initialization:
      continue

    device.field = getMappedPou(device, CLIENT_POINTS, "Client", "_DNP", keyedClients )
    device.scada = getMappedPou(device, SERVER_POINTS, "Server", "_DNP", keyedServers )

    devDefId : str = ""
    devDefAssignments : Dict[str,VarAssignment] = device.initialization.getMethodPoint("DeviceDefinition")
    
    for methodName, devDefAssignment in devDefAssignments.items():
      if "DFO" not in methodName.upper():
        devDefId = devDefAssignment.right.strip().upper()
        break

    try:
      device.deviceDefinition = keyedDevDef[devDefId.strip().upper()] 

    except:
      print(f"No Device Definition found for {device.name}.")
      print(f"Device Definition ID: {devDefId}")
      print("Available Device Definitions:")
      pprint(keyedDevDef.keys())
      device.deviceDefinition = None
      input("Press Enter to continue...")

