
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common import VarAssignment

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink, initDfoScadaLink



initLogic = DeviceRule(
    name='mInit',
    dacName='Init',
    parameters=[
        VarAssignment().fromInputs("SubstationName", "'New Sub' {error 'Needs manual population'}", ''),
        VarAssignment().fromInputs("Name", '', ''),
        VarAssignment().fromInputs("VoltageLL", getTransformerVoltage, ''),
        VarAssignment().fromInputs("Capacity", '', ''),
        VarAssignment().fromInputs("TempCapacity", '', ''),
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

initLogicDfo = DeviceRule(
    name='mInitDfo',
    dacName='InitDfo',
    parameters=[
        VarAssignment().fromInputs("DeviceDefinition", '', '')
    ]
)

initRemote = DeviceRule(
    name='mInit',
    dacName='Init',
    parameters=[ 
        VarAssignment().fromInputs("SubstationName", "'New Sub' {error 'Needs manual population'}", ''),
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
  'SIM_BKR': logicMappingRules,
  'SIM_BKR_REMOTE': remoteMappingRules,
}