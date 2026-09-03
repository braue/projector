
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDfoScadaLink



initLogic = DeviceRule(
    name='mInit',
    dacName='Init',
    parameters=[
      VarAssignment().fromInputs("Name", '', ''),
      VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
      VarAssignment().fromInputs("pFieldFirst_BI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AI", getFieldTagName, ''),
      VarAssignment().fromInputs("pEN", getpEn, ''),
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


initRemote = DeviceRule(
    name='mInit',
    dacName='Init',
    parameters=[
      VarAssignment().fromInputs("Name", '', ''),
      VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
      VarAssignment().fromInputs("pFieldFirst_BI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_CNT", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_BO", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AO", getFieldTagName, ''),
      VarAssignment().fromInputs("pEN", getpEn, ''),
      VarAssignment().fromInputs("Manager", getRemoteManager, '')
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
    initDfoScadaLink
  ]


remoteMappingRules = DeviceRules()
remoteMappingRules.methods=[
    initRemote,
    initRemoteDfo,
    initDfoScadaLink
  ]


mappingRules = {
  LOGIC: logicMappingRules,
  REMOTE_IO: remoteMappingRules,
}