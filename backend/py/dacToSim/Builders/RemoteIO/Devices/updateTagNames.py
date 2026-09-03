from typing import Dict, List
from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Connections import ConnectionFiles



METHODS_WITH_COMM_TAGS = ["MINIT","INIT","INITLOOP","INITDASCADALINK","INITDFOSCADALINK"]
TAG_INPUTS = ["PEN","PFIELDFIRST_AI","PFIELDFIRST_AO","PFIELDFIRST_BI","PFIELDFIRST_BO","PFIELDFIRST_CNT","PFIRST_AI","PFIRST_AO","PFIRST_BI","PFIRST_BO","PFIRST_CNT",]


def _updateDeviceTagNames(device:Device, tagNameUpdates:Dict[str,str]) -> None:
    """
    Update the tag names in the remote projects based on the tagNameUpdates dictionary.
    """
    filteredMethods = {method for (key, method) in device.initialization.methods.items() if key.upper() in METHODS_WITH_COMM_TAGS}

    for init in filteredMethods:
      filteredParams = [param for (key, param) in init.inputs.items() if key.upper() in TAG_INPUTS]
      for param in filteredParams:
        if isinstance(param.right,str):
          param.right = param.right.replace(tagNameUpdates['old'], tagNameUpdates['new'])
      
  
def updateTagNames(devicesByConnection:Dict[ConnectionFiles,List[Device]], connection:ConnectionFiles, tagNameUpdates:Dict[str,str]) -> None:
    """
    Update the tag names in the remote projects based on the tagNameUpdates dictionary.
    """
    try:
      devices = devicesByConnection[connection]
      for dev in devices:
        _updateDeviceTagNames(dev, tagNameUpdates)
    except KeyError:
      pass