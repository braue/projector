from __future__ import annotations
from pathlib import Path
from typing import List,Dict,Tuple,Set
from pprint import pprint
import math


from dacToSim.DataModel.Device.Connections.connections import ConnectionFiles
from dacToSim.DataModel.Device import Device



def getDevicesByFieldConnection(deviceList:List[Device]) -> Dict[ConnectionFiles,List[Device]]:
  boundConnections : Dict[ConnectionFiles,List[Device]] = {}

  for device in deviceList:
    if not device.field: continue

    if device.field not in boundConnections:
      boundConnections[device.field] = []
    boundConnections[device.field].append(device)

  return boundConnections

def getDevicesByScadaConnection(deviceList:List[Device]) -> Dict[ConnectionFiles,List[Device]]:
  boundConnections : Dict[ConnectionFiles,List[Device]] = {}

  for device in deviceList:
    if not device.scada: continue

    if device.scada not in boundConnections:
      boundConnections[device.scada] = []
    boundConnections[device.scada].append(device)

  return boundConnections


def getScadaFieldConnections(deviceList:List[Device]) -> Dict[ConnectionFiles,List[ConnectionFiles]]:
  boundConnections : Dict[ConnectionFiles,List[ConnectionFiles]] = {}

  for device in deviceList:
    if not device.scada: continue

    if device.scada not in boundConnections:
      boundConnections[device.scada] = []
    boundConnections[device.scada].append(device.field)

  return boundConnections


def orderByItemLength(obj,reverse=False):
  return dict(sorted(obj.items(), key=lambda item: len(item[1]), reverse=reverse)) 


class ConnectionAllocations():

  def __init__(self):
    self.device:Set[Device] = set()
    self.field:Set[ConnectionFiles] = set()
    self.scada:Set[ConnectionFiles] = set()

MAX_VRTU_MAPS = 100


def popLast(dic:Dict):
  lastKey = list(dic)[-1]
  return (lastKey,dic.pop(lastKey))

def popFirst(dic:Dict):
  firstKey = list(dic)[0]
  return (firstKey,dic.pop(firstKey))

def allocateSimConnections(dacDeviceList:List[Device]) -> List[ConnectionAllocations]:
  fieldDeviceLists = getDevicesByFieldConnection(dacDeviceList)
  scadaDeviceLists = getDevicesByScadaConnection(dacDeviceList)


  unallocFieldDeviceLists = getDevicesByFieldConnection(dacDeviceList)
  unallocScadaFieldLists = orderByItemLength(getScadaFieldConnections(dacDeviceList))
  

  remoteIoAllocation : List[ConnectionAllocations] = []
  for i in range(max(math.ceil(len(fieldDeviceLists)/100) , 1)):
    remoteIoAllocation.append(ConnectionAllocations())

  # define types
  scada : ConnectionFiles
  field : ConnectionFiles
  fieldList : List[ConnectionFiles]
  deviceList : List[Device]
  
  # link connections by scada
  while unallocScadaFieldLists:
    (scada, fieldList) = popLast(unallocScadaFieldLists)

    while scada or fieldList:
      remoteIoAllocation.sort(key=lambda remoteIO:len(remoteIO.field))

      for remoteIo in remoteIoAllocation:
        if scada:
          remoteIo.scada.add(scada)
          scada = None

        while fieldList and (len(remoteIo.field)) <= MAX_VRTU_MAPS:
          fieldToAlloc = fieldList.pop()
          if not fieldToAlloc: continue
          remoteIo.field.add(fieldToAlloc)
          unallocFieldDeviceLists.pop(fieldToAlloc,None)

  # link any field connections not related to scada
  remoteIoAllocation.sort(key=lambda remoteIO:len(remoteIO.field))
  for remoteIO in remoteIoAllocation:
    while len(remoteIO.field) <= MAX_VRTU_MAPS and unallocFieldDeviceLists:
      (field, deviceList) = popFirst(unallocFieldDeviceLists)
      if not field: continue
      remoteIO.field.add(field)

  # link devices to the remoteIO
  for remoteIO in remoteIoAllocation:
    for scada in remoteIO.scada:
      if not scada: continue
      try:
        remoteIO.device.update(scadaDeviceLists[scada])
      except:
        print(f"Error allocating scada connection {scada.connection.name} to remote IO")
        pprint(scadaDeviceLists)
        raise

    for field in remoteIO.field:
      if not field: continue
      try:
        remoteIO.device.update(fieldDeviceLists[field])
      except:
        print(f"Error allocating field connection {field.connection.name} to remote IO")
        pprint(fieldDeviceLists)
        raise

  return remoteIoAllocation

  