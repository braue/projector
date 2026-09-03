
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink, initDfoScadaLink





initLogic = DeviceRule(
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
      VarAssignment().fromInputs("Manager", getRemoteManager, '')
    ]
)

initLogicLoop = DeviceRule(
    name='mInitLoop',
    dacName='InitLoop',
    parameters=[
      VarAssignment().fromInputs("Name", '', ''),
      VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
      VarAssignment().fromInputs("pFieldFirst_BI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_CNT", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_BO", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AO", getFieldTagName, ''),
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
      VarAssignment().fromInputs("Manager", getRemoteManager, '')
    ]
)

initRemoteLoop = DeviceRule(
    name='mInit',
    dacName='InitLoop',
    parameters=[
      VarAssignment().fromInputs("Name", '', ''),
      VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
      VarAssignment().fromInputs("pFieldFirst_BI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AI", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_CNT", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_BO", getFieldTagName, ''),
      VarAssignment().fromInputs("pFieldFirst_AO", getFieldTagName, ''),
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
    initLogicLoop,
    initLogicDfo,
    initDaScadaLink,
    initDfoScadaLink
  ]


remoteMappingRules = DeviceRules()
remoteMappingRules.methods=[
    initRemote,
    initRemoteLoop,
    initRemoteDfo,
    initDaScadaLink,
    initDfoScadaLink
  ]


mappingRules = {
  LOGIC: logicMappingRules,
  REMOTE_IO: remoteMappingRules,
}