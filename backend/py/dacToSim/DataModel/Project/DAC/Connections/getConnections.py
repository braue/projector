from pathlib import Path
from typing import List,Dict,Literal

from dacToSim.constants.names import folders

from .fileHandling import collectFiles

from dacToSim.DataModel.Device.Connections import ConnectionData, TagMapData, ConnectionFiles
from dacToSim.DataModel.Profile import Scheme

PROTOCOL_CHECK = "<Protocol>{protocol}</Protocol>"
TAGLIST = '<TagListType>{protocol}</TagListType>'


def getDacClientConnections(folderPath:Path, profile:Scheme,protocol:Literal["DNP"] = "DNP" ) -> List[ConnectionFiles]:
  clients = collectFiles(['System'],['Project Info.xml'],PROTOCOL_CHECK.format(protocol=f'{protocol}Client'))

  mapRoot = folderPath

  clients.Search(mapRoot)

  clientConnection : List[ConnectionFiles] = []

  for filePath in clients.files:
    clientConnection.append(ConnectionFiles().fromClientPath(filePath.path))

  return clientConnection


def getDacServerConnections(folderPath:Path, profile:Scheme,protocol:Literal["DNP"] = "DNP") -> List[ConnectionFiles]:
  serverPaths = collectFiles(['System'],['Project Info.xml'],PROTOCOL_CHECK.format(protocol=f'{protocol}Server'))
  tagMapPaths = collectFiles(['System'],['Project Info.xml'],TAGLIST.format(protocol=f'{protocol}'))

  mapRoot = folderPath

  serverPaths.Search(mapRoot)
  tagMapPaths.Search(mapRoot)

  servers = [ConnectionData(x.path) for x in serverPaths.files]
  tagMaps = {x.name:TagMapData(x.path) for x in tagMapPaths.files}

  serverConnections : List[ConnectionFiles] = []

  for server in servers:
    if server.tagMapName not in tagMaps:
      print(f"Scheme: {profile.schemeName}; ServerName: {server.name}; TagMapName not assigned. Connection not transfer to Simulator")

    serverConnections.append(ConnectionFiles().fromData(server,tagMaps[server.tagMapName]))



  return serverConnections
