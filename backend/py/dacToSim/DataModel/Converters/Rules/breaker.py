
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC



from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink, initPowerDir

initLogic = DeviceRule(
  name='mInit',
  dacName='Init',
  parameters=[
    VarAssignment().fromInputs("Name", '', ''),
    VarAssignment().fromInputs("NormallyOpen", 'False', ''),
    VarAssignment().fromInputs("NormalSG", 'eSG1', ''),
    VarAssignment().fromInputs("SideA_PT_Set", '', ''),
    VarAssignment().fromInputs("LoadSideB", getDefaultLoadSide, ''),
    VarAssignment().fromInputs("PF", getDefaultPowerFactor, ''),
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

initLogicLoop = DeviceRule(
  name='mInitLoop',
  dacName='InitLoop',
  parameters=[
    VarAssignment().fromInputs("Name", '', ''),
    VarAssignment().fromInputs("NormallyOpen", 'False', ''),
    VarAssignment().fromInputs("NormalSG", 'eSG1', ''),
    VarAssignment().fromInputs("SideA_PT_Set", '', ''),
    VarAssignment().fromInputs("LoadSideB", getDefaultLoadSide, ''),
    VarAssignment().fromInputs("PF", getDefaultPowerFactor, ''),
    VarAssignment().fromInputs("Capacity", '', ''),
    VarAssignment().fromInputs("TempCapacity", '', ''),
    VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
    VarAssignment().fromInputs("ForwardFaultDirection", '', ''),
    VarAssignment().fromInputs("pFieldFirst_BI", getFieldTagName, ''),
    VarAssignment().fromInputs("pFieldFirst_AI", getFieldTagName, ''),
    VarAssignment().fromInputs("pFieldFirst_CNT", getFieldTagName, ''),
    VarAssignment().fromInputs("pFieldFirst_BO", getFieldTagName, ''),
    VarAssignment().fromInputs("pFieldFirst_AO", getFieldTagName, ''),
    VarAssignment().fromInputs("pEN", getpEn, ''),
    VarAssignment().fromInputs("Manager", getRemoteManager, '')
  ]    
)

initLogicSpare = DeviceRule(
  name='InitSpareBkr',
  parameters=[
    VarAssignment().fromInputs("SpareBreaker", '', ''),
  ]
)

initRemote  = DeviceRule(
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

initRemoteLoop  = DeviceRule(
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
    VarAssignment().fromInputs("pEN", getpEn, ''),
    VarAssignment().fromInputs("Manager", getRemoteManager, '')
  ]    
)


logicMappingRules = DeviceRules()
logicMappingRules.methods=[
    initLogic,
    initLogicLoop,
    initLogicSpare,
    initDaScadaLink,
    initPowerDir
  ]



remoteMappingRules = DeviceRules()
remoteMappingRules.methods=[
    initRemote,
    initRemoteLoop,
    initDaScadaLink
  ]

mappingRules = {
  LOGIC: logicMappingRules,
  REMOTE_IO: remoteMappingRules,
}