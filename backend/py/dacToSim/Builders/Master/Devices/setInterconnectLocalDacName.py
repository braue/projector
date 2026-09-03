from typing import List, Dict
from dacToSim.DataModel.Device import Device

from dacToSim.DataModel.Common import VarAssignment



def _getControllerName(devices: List[Device]) -> str:
  """
  Retrieves the controller name from the devices list.
  Assumes that there is only one controller device in the list.
  """
  controller: Device = None
  
  for dacDevice in devices:
    if dacDevice.deviceDeclaration.type.upper() in ["DA_CONTROL", "SIM_CONTROL"]:
      controller = dacDevice
      break

  if controller is None:
    raise Exception("No DA_Control found in DAC Devices. Cannot link interconnects.")
  
  if controller.initialization is None or controller.initialization.call is None:
    raise Exception(f"DA_Control {controller.qualifiedName} is not called. DAC improperly configured.")
  
  for input in controller.initialization.call.inputs.values():
    if input.left.upper() == "NAME":
      return input.right

  raise Exception("DA_Controller does not have a NAME input. DAC improperly configured.")
  

def setInterconnectLocalDacName(devices: List[Device]) -> None:
  controllerName = _getControllerName(devices)
  if not controllerName:
    raise Exception("Controller name could not be determined. Cannot set interconnect local DAC name.")
  
  for device in devices:
    if "INTERCONNECT_MANAGER" in device.deviceDeclaration.type.upper():
      method = device.initialization.methods.get("INIT")
      if not method:
        raise Exception(f"DAC_INTERCONNECT_MANAGER {device.qualifiedName} does not have an INIT method.")
      # Attach the controller name to the interconnect
      method.appendIO(
        VarAssignment().fromInputs(
          left="LocalDacName",
          right=controllerName,
          comment=""
        ),
        ':='
      )
  