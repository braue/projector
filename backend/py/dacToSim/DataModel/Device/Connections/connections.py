from pathlib import Path
from typing import List,Dict
import re
import copy
from dacToSim.constants.names import folders
from dacToSim.constants.names.simRemoteIoNames import CLIENT_NAME, SERVER_NAME, SERVER_TAG_NAME, PROT_DNP
from dacToSim.common import getRelativeToFolderName, writeFile


GET_CONNECTION_NAME = re.compile(r"<Name>(.*)</Name>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_SRV_DNP_ADR = re.compile(r"<Value>Server DNP Address</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_CLI_DNP_ADR = re.compile(r"<Value>Client DNP Address</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_SRV_IP_ADDR = re.compile(r"<Value>Server IP Address</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_SRV_IP_PORT = re.compile(r"<Value>Server IP Port</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_CLI_IP_ADDR = re.compile(r"<Value>Client IP Addresses</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_CLI_IP_PORT = re.compile(r"<Value>Client IP Port</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)
GET_CONNECTION_MAP_NAME = re.compile(r"<Value>Map Name</Value>.*(?:\n.*?)*?<Value>(.*?)</Value>", re.IGNORECASE | re.MULTILINE)

REDUNDANCY_SUFFIXES = ["", "_B", "_C", "_D"]

from . import Conversion

def getGroupOrDefault(data:str, Pattern:re.Pattern, group:int|str, default:int|str) -> int|str:
  """
  Extracts a group from the data using the provided pattern.
  If the group is not found, returns the default value.
  """
  match = Pattern.search(data)
  if match:
    results = match.group(group)
  else:
    results = default
  
  if isinstance(results, str):
    return str(results).strip()
  elif isinstance(results, int):
    return int(results)

def getGroupOrDefaultList(data:str, Pattern:re.Pattern, group:int|str, default:List[str]=[]) -> List[str]:
  """
  Extracts a group from the data using the provided pattern.
  If the group is not found, returns an empty list.
  """
  match = Pattern.search(data)
  if match:
    results = match.group(group)
    if results:
      return [x.strip() for x in results.split(",") if x.strip()]
    else:
      return default
  else:
    return default


class ConnectionData:
  def __init__(self, path:Path):
    data = path.read_text()
    self.path:Path = path
    self.name:str = GET_CONNECTION_NAME.search(data).group(1)
    self.tagMapName:str = getGroupOrDefault(data, GET_CONNECTION_MAP_NAME,1,"self")
    self.srvIpAddr:str = getGroupOrDefault(data, GET_CONNECTION_SRV_IP_ADDR,1,"")
    self.srvIpPort:int = int(GET_CONNECTION_SRV_IP_PORT.search(data).group(1))
    self.cliIpAddr:List[str] = getGroupOrDefaultList(data, GET_CONNECTION_CLI_IP_ADDR,1,['20.20.20.20'])
    self.cliIpPort:int = getGroupOrDefault(data, GET_CONNECTION_CLI_IP_PORT, 1, 0)

    self.protocolSrvAddr:int = int(GET_CONNECTION_SRV_DNP_ADR.search(data).group(1))
    self.protocolCliAddr:int = int(GET_CONNECTION_CLI_DNP_ADR.search(data).group(1))

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
  
  def GetName(self,index:int=0):
    return f"{self.name}{REDUNDANCY_SUFFIXES[index]}"

class TagMapData:
  def __init__(self,path):
    self.path:Path=path
    self.name:str=self._GetMapName(Path(self.path).read_text())
    self._tagData:Dict[str,str] = {}

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result

  def _GetMapName(self,tagMapBody):
    if "<TagListType>" in tagMapBody:
      return re.search(r"<Name>(.*?)</Name>.*?\n.*?<TagListType>\w+</TagListType>", tagMapBody, re.IGNORECASE | re.MULTILINE).group(1)
    elif "<Protocol>" in tagMapBody:
      return re.search(r"<Name>(.*?)</Name>.*?\n.*?<Manufacturer>\w+</Manufacturer>", tagMapBody, re.IGNORECASE | re.MULTILINE).group(1)


  def _GetTagMap(self,tagMapBody,group:str):
    pattern = f'<SettingPage>.*\n.*?<Name>{group}</Name>.*((?:\n.*?)*?)</SettingPage>'
    return re.search(pattern, tagMapBody, re.IGNORECASE | re.MULTILINE).group(1)

  def GetTagList(self,group:str):
    intGroup = group.replace(' ','')
    if intGroup not in self._tagData:
      self._tagData[group.replace(' ','')]=self._GetTagMap(Path(self.path).read_text(), group)
    
    return self._tagData[intGroup]
  
  def GetDnpTagLists(self):
    for page in ['Binary Inputs','Double Bit Inputs','Binary Outputs','Counters','Analog Inputs','Analog Outputs','Datasets']:
      self.GetTagList(page)
    return self._tagData
  
  def GetName(self,index:int=0):
    return f"{self.name}{REDUNDANCY_SUFFIXES[index]}"
 
class ConnectionFiles:
  def __init__(self):
    self.connection:ConnectionData
    self.tagMap:TagMapData

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
  
  def fromClientPath(self, path:Path):
    if not path.exists():
      raise FileNotFoundError(f"Connection file {path} does not exist.")
    
    self.connection = ConnectionData(path)
    self.tagMap = TagMapData(path)
    
    return self
  
  def fromServerPath(self, srvPath:Path, tagMapPath:Path):
    if not srvPath.exists():
      raise FileNotFoundError(f"Server connection file {srvPath} does not exist.")
    if not tagMapPath.exists():
      raise FileNotFoundError(f"Tag map file {tagMapPath} does not exist.")
    
    self.connection = ConnectionData(srvPath)
    self.tagMap = TagMapData(tagMapPath)
    
    return self
  
  def fromData(self, srv:ConnectionData, tagMap:TagMapData):
    if not isinstance(srv, ConnectionData):
      raise TypeError("srv must be an instance of ConnectionData")
    if not isinstance(tagMap, TagMapData):
      raise TypeError("tagMap must be an instance of TagMapData")
    
    self.connection = srv
    self.tagMap = tagMap
    
    return self
  

  def GetTagData(self,group:str):
    if not self.tagMap:
      print("Tag map is not set. Cannot get DNP tags.")
      return {}
    return self.tagMap.GetTagList(group)  
  
  def GetDnpTagLists(self):
    
    if not self.tagMap:
      print("Tag map is not set. Cannot get DNP tags.")
      return {}
    return self.tagMap.GetDnpTagLists()



  def convertToClient(self, path:Path, schemeName:str, serverIpAddr:str|List[str], integrityPollPeriod:int=5000, eventPollPeriod:int=1000):
    if isinstance(serverIpAddr, str):
      serverIpAddr = [serverIpAddr]

    if self.connection.path == self.tagMap.path:
      raise ValueError("Cannot convert to client connection file with the same path as server connection file.")
    

    baseTagMapName = self.tagMap.name
    baseTagMapData = self.GetDnpTagLists()

    tagNameChange = {'old':self.tagMap.name}

    self.connection.name = CLIENT_NAME.format(schemeName=schemeName, connectionName=self.connection.GetName(0))
    self.tagMap.name = self.connection.GetName(0)

    tagNameChange['new'] = self.tagMap.GetName(0)

    srcRelativePath = getRelativeToFolderName(self.connection.path, folders.CONNECTIONS)
    folderPath = path / srcRelativePath / folders.SCADA_CONNECTIONS

    self.connection.path = folderPath /   f"{PROT_DNP.format(self.connection.GetName(0))}.xml"
    self.tagMap.path = folderPath / f"{PROT_DNP.format(self.tagMap.GetName(0))}.xml"

    self.connection.path.parent.mkdir(parents=True, exist_ok=True)
    self.tagMap.path.parent.mkdir(parents=True, exist_ok=True)


    workingCliIpPort = self.connection.cliIpPort
    for i, ip in enumerate(serverIpAddr):
      tempClientName = self.connection.GetName(i)
      if i > 0:
        workingCliIpPort += 100

      tagMapData = { mapName.replace(" ",""): data.replace(baseTagMapName,tempClientName)  for mapName, data in baseTagMapData.items()}

      workingPath = folderPath / f"{PROT_DNP.format(tempClientName)}.xml" 
      writeFile(
        workingPath, 
        Conversion.clientPattern(
          name=tempClientName,
          clientDnpAddr=self.connection.protocolCliAddr,
          serverDnpAddr=self.connection.protocolSrvAddr,
          
          clientIpPort=workingCliIpPort,
          serverIpAddr=ip,
          serverIpPort=self.connection.srvIpPort,

          integrityPollPeriod=integrityPollPeriod,
          eventPollPeriod=eventPollPeriod,
          **tagMapData
        ),
        True
      )


    return tagNameChange


  def convertToServer(self, path:Path, dacIpAddr:str|List[str], clientIpAddr:str|List[str]) -> Dict[str,str]:
    if isinstance(dacIpAddr, str):
      dacIpAddr = [dacIpAddr]

    if isinstance(clientIpAddr, str):
      clientIpAddr = [clientIpAddr]

    if self.connection.path != self.tagMap.path:
      raise ValueError("Cannot convert to server connection file with different paths for connection and tag map files.")
    
    tagNameChange = {'old':self.tagMap.name}
    
    srcRelativePath = getRelativeToFolderName(self.connection.path, folders.CONNECTIONS)

    srvName = SERVER_NAME.format(self.connection.GetName(0))
    tagListName = SERVER_TAG_NAME.format(self.connection.GetName(0))


    self.connection.path = path / srcRelativePath / f"{PROT_DNP.format(srvName)}.xml"
    self.connection.name = srvName
    self.connection.path.parent.mkdir(parents=True, exist_ok=True)
    self.tagMap.name = tagListName
    tagNameChange['new'] = tagListName

    workingSrvIpPort = self.connection.srvIpPort

    for i, ip in enumerate(dacIpAddr):    
      tempServerName = self.connection.GetName(i)
      
      if i > 0:
        workingSrvIpPort += 1000

      workingPath = self.connection.path.parent / f"{PROT_DNP.format(tempServerName)}.xml"

      writeFile(
        workingPath,
        Conversion.serverPattern(
          name=tempServerName,
          serverIpPortSim=workingSrvIpPort,
          serverDnpAddr=self.connection.protocolSrvAddr,
          clientDnpAddr=self.connection.protocolCliAddr,
          clientIpAddr='192.168.254.1',
          serverMapName=self.tagMap.GetName(0),
        ),
        True
      )
      
    self.tagMap.path = path / srcRelativePath / folders.TAGMAP / f"{PROT_DNP.format(self.tagMap.GetName(0))}.xml"
    self.tagMap.path.parent.mkdir(parents=True, exist_ok=True)
    

    writeFile(
      self.tagMap.path, 
      Conversion.tagMapPattern(
        name=self.tagMap.GetName(0),
        **self.GetDnpTagLists()
      ),
      True
    )

    return tagNameChange
      


