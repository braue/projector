from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink, initPowerDir

from dacToSim.DataModel.Converters.common.field import initLogic, initLogicLoop, initRemote, initRemoteLoop
from dacToSim.DataModel.Converters.common.defaultValuesFunctions import getSimSrcId


initSg = DeviceRule(
  name='InitSettingsGroups',
  dacName='InitSettingsGroups',
  parameters=[
    VarAssignment().fromInputs("SRC_A", getSimSrcId , ''),
    VarAssignment().fromInputs("SG_A", '', ''),
    VarAssignment().fromInputs("SRC_B", getSimSrcId, ''),
    VarAssignment().fromInputs("SG_B", '', ''),
    VarAssignment().fromInputs("SRC_C", getSimSrcId, ''),
    VarAssignment().fromInputs("SG_C", '', ''),
    VarAssignment().fromInputs("SRC_D", getSimSrcId, ''),
    VarAssignment().fromInputs("SG_D", '', ''),
    VarAssignment().fromInputs("SRC_E", getSimSrcId, ''),
    VarAssignment().fromInputs("SG_E", '', ''),
    VarAssignment().fromInputs("SRC_F", getSimSrcId, ''),
    VarAssignment().fromInputs("SG_F", '', '')
  ]    
)

logicMappingRules = DeviceRules()
logicMappingRules.methods=[
    initLogic,
    initLogicLoop,
    initDaScadaLink,
    initSg,
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