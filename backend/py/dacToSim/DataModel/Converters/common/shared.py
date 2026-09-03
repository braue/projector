from dacToSim.DataModel.Converters.DeviceRules import DeviceRules, DeviceRule
from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.DataModel.Converters.common.defaultValuesFunctions import getScadaTagName



initDaScadaLink = DeviceRule(
  name='InitDaScadaLink',
  parameters=[ 
    VarAssignment().fromInputs("pFirst_Bi", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Ai", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Bo", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Ao", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Cnt", getScadaTagName, '')
  ]
)

initDfoScadaLink = DeviceRule(
  name='InitDfoScadaLink',
  parameters=[ 
    VarAssignment().fromInputs("pFirst_Bi", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Ai", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Bo", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Ao", getScadaTagName, ''),
    VarAssignment().fromInputs("pFirst_Cnt", getScadaTagName, '')
  ]
)

initPowerDir = DeviceRule(
  name='InitPowerDir',
  parameters=[
    VarAssignment().fromInputs("PositivePowerDirection", '', '')
  ]
)