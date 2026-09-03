from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink, initPowerDir

from dacToSim.DataModel.Converters.common.field import initLogic, initLogicLoop, initRemote, initRemoteLoop


logicMappingRules = DeviceRules()
logicMappingRules.methods=[
    initLogic,
    initLogicLoop,
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