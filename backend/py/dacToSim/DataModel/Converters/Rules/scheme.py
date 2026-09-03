
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink, initDfoScadaLink

initLogic = DeviceRule(
    name='mInit',
    dacName='self',
    parameters=[
        VarAssignment().fromInputs("Name", '', ''),
        VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
        VarAssignment().fromInputs("Manager", getRemoteManager, '')
    ]
)

initRemote = DeviceRule(
    name='mInit',
    dacName='self',
    parameters=[
        VarAssignment().fromInputs("Name", '', ''),
        VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
        VarAssignment().fromInputs("Manager", getRemoteManager, '')
    ]
)

initLogicDfo = DeviceRule(
    name='mInitDfo',
    dacName='InitDfo',
    parameters=[
        VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, '')
    ]
)

initRemoteDfo = DeviceRule(
    name='mInitDfo',
    dacName='InitDfo',
    parameters=[
        VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, '')
    ]
)


logicMappingRules = DeviceRules()
logicMappingRules.methods=[
    initLogic,
    initLogicDfo,
    initDaScadaLink,
    initDfoScadaLink
  ]


remoteMappingRules = DeviceRules()
remoteMappingRules.methods=[
    initRemote,
    initRemoteDfo,
    initDaScadaLink,
    initDfoScadaLink
  ]


mappingRules = {
  LOGIC: logicMappingRules,
  REMOTE_IO: remoteMappingRules,
}