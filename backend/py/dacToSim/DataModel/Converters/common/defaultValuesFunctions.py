from __future__ import annotations

from dacToSim.DataModel.Common.logicTypes import VarAssignment
from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Profile import Scheme
from dacToSim.constants.projectTypes import REMOTE_IO, DAC
from dacToSim.constants.names import simMasterNames as masterPatterns

from .helpers import replacePouName, getUniqueName


simulatorNullTypes = {
  'BKR':	'NullDefinitions.NullBreaker',
  'SUB_BUS':	'NullDefinitions.NullBus_AR',
  'SUB_BUSDFO':	'',
  'CAP':	'',
  'FDR':	'NullDefinitions.NullCircuit',
  'FDRDFO':	'',
  'CONTROLLER':	'NullDefinitions.NullScheme',
  'CONTROLLERDFO':	'',
  'DAC_INTERCONNECT':	'',
  'DAC_INTERCONNECTMANAGER':	'',
  'DG':	'',
  'DUAL_SW':	'',
  'FEEDER':	'NullDefinitions.NullFeeder',
  'FEEDERGROUP':	'',
  'LOAD':	'',
  'SUB_MAIN':	'NullDefinitions.NullMain',
  'MANSW':	'NullDefinitions.NullSwitchNoProt',
  'PRIORITYLOAD':	'',
  'PSEUDO_BKR':	'NullDefinitions.NullPseudoBreaker',
  'REC':	'NullDefinitions.NullRecloser',
  'REG':	'',
  'RTUVOTEMASTER':	'',
  'SCHEME':	'NullDefinitions.NullScheme',
  'SCHEMEDFO':	'',
  'SW':	'NullDefinitions.NullSwitch',
  'SUB_TIE':	'NullDefinitions.NullTie',
  'SUB_TRANSFORMER':	'NullDefinitions.NullTransformer',
  'SUB_TRANSFORMERDFO':	''
}



def getpEn(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  if device.field is None:
    return None
  if "_DNP" not in device.field.connection.name:
    return f"ADR({device.field.connection.GetName(0)}_DNP_POU.EN)"
  else:
    return f"ADR({device.field.connection.GetName(0)}_POU.EN)"

  

def getRemoteManager(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  if projectType == REMOTE_IO:
    return ''
  else:
    return f"ADR({masterPatterns.INIT_REMOTE_IO.format(schemeName=scheme.schemeName)}.Manager)"
  
def getDefaultLoadSide(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  return scheme.parameters.defaultLoad

def getDefaultPowerFactor(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  if hasattr(scheme.parameters, 'defaultPowerFactor'):
    return scheme.parameters.defaultPowerFactor
  else:
    return '0.95'


def getDefaultDeviceDefinition(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  if device.deviceDefinition and device.deviceDefinition.name:
    return device.deviceDefinition.qualifiedName
  
  if projectType == DAC:
    return "UndefinedDefinitions.UndefinedDeviceDefinition"
  else:
    try:
      return simulatorNullTypes[device.deviceDeclaration.BaseType]
    except:
      print(f"Warning: No Null Definition for {device.deviceDeclaration.BaseType} in {projectType}")
      return "NullDefinitions.NullDeviceDefinition"
    

def getSchemeName(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  return scheme.schemeName

def getSubstationName(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  try:
    return device.initialization.methods['MINIT'].inputs["SubstationName".upper()].right
  except:
    seed = "'New Sub' {error 'Needs manual population'}"

    if old and old.right and old.right.find(seed):
      return old.right
    else:
      return seed

def getTransformerVoltage(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  try:
    return device.initialization.methods['MINIT'].inputs["VoltageLL".upper()].right
  except:
    seed = "12470 {error 'Verify voltage level'}"

    if old and old.right and old.right.find(seed):
      return old.right
    else:
      return seed

def getFieldTagName(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  return replacePouName(old, device.field)


def getScadaTagName(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  return replacePouName(old, device.scada)


def getSimSrcId(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  # if old empty return empty
  if not old or not old.right:
    return ''
  
  if not old.right.upper().endswith('.ID'):
    return "''"

  srcName = old.right.upper().replace(".ID","")

  # Get new source from nameConversions if renamed
  newSrcNames = [x for x in scheme.nameConversions if x.old.upper() == srcName]

  if newSrcNames:
    srcName = newSrcNames[0].new

  return f"{srcName}.ID"
  

def getInterconnectManagerName(old:VarAssignment, device:Device, scheme:Scheme, projectType:str) -> str:
  if projectType == REMOTE_IO:
    return old.right if old and old.right else f"{scheme.schemeName}_Manager"
  else:
    return getUniqueName(old, scheme)


  