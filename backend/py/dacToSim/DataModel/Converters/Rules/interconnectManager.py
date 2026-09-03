
from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.constants.projectTypes import REMOTE_IO,  LOGIC

from dacToSim.DataModel.Converters.common.defaultValuesFunctions import *
from dacToSim.DataModel.Converters.common.shared import initDaScadaLink




### Need to handle namespace conflict for manager in the DAC

initLogic = DeviceRule(
  name='mInit',
  dacName='Init',
  parameters=[
    VarAssignment().fromInputs("LocalDacName", '', ''),
    VarAssignment().fromInputs("RemoteDacName", '', ''),
    VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, '')
  ]
)

initRemote  = DeviceRule(
  name='mInit',
  dacName='Init',
  parameters=[
    VarAssignment().fromInputs("LocalDacName", '', ''),
    VarAssignment().fromInputs("RemoteDacName", '', ''),
    VarAssignment().fromInputs("DeviceDefinition", getDefaultDeviceDefinition, '')
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



