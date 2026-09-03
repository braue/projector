
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO,  LOGIC

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink



initLogic = DeviceRule(
  name='mInit',
  dacName='Init',
  parameters=[
    VarAssignment().fromInputs("Name", '', ''),
    VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
    VarAssignment().fromInputs("Manager", getInterconnectManagerName, '')
  ]
)


initRemote  = DeviceRule(
  name='mInit',
  dacName='Init',
  parameters=[
    VarAssignment().fromInputs("Name", '', ''),
    VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, ''),
    VarAssignment().fromInputs("Manager", getInterconnectManagerName, '')
  ]    
)

logicMappingRules = DeviceRules()
logicMappingRules.methods=[
    initLogic,
    initDaScadaLink
  ]


remoteMappingRules = DeviceRules()
remoteMappingRules.methods=[
    initRemote,
    initDaScadaLink  
  ]



mappingRules = {
  LOGIC: logicMappingRules,
  REMOTE_IO: remoteMappingRules,
}