
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment

from dacToSim.DataModel.Profile.profile import Scheme
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *

Warning

initLogic = DeviceRule(
    name='Init',
    dacName='',
    parameters=[
        VarAssignment().fromInputs("Name", getSchemeName, ''),
        VarAssignment().fromInputs("IpMaster", 'Gateway.Head_SIM_IP', ''),
        VarAssignment().fromInputs("IpPort", '59001', '')
    ]
)

def addLogicRemoteIp(device: DeviceRule, scheme: Scheme):
    """
    Adds the remote IP address to the device.
    """
    for i, ipAddr in enumerate(scheme.remote.ipAddr):
        
        device.parameters.append(
            VarAssignment().fromInputs(f"IpRem{i+1}", f"Gateway.{scheme.schemeName.replace(" ","_")}_SIM_IP[{i+1}]", '')
        )



initRemote = DeviceRule(
    name='Init',
    dacName='',
    parameters=[
        VarAssignment().fromInputs("Name", getSchemeName, ''),
        VarAssignment().fromInputs("IpMaster", 'SimHead_IP', ''),
        VarAssignment().fromInputs("IpRem1", 'LocalIp', ''),
        VarAssignment().fromInputs("IpPort", '59001', '')
    ]
)


runRemote = DeviceRule(
    name='Run',
    parameters=[]
)



logicMappingRules = DeviceRules()
logicMappingRules.methods=[
    initLogic
  ]


remoteMappingRules = DeviceRules()
remoteMappingRules.methods=[
    initRemote,
    runRemote
  ]


mappingRules = {
  LOGIC: logicMappingRules,
  REMOTE_IO: remoteMappingRules,
}