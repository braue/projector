from __future__ import annotations

from dacToSim.DataModel.Converters.Rules import breaker, bus, circuit, dg, interconnect, interconnectManager, mansw
from dacToSim.DataModel.Converters.Rules import recloser, remoteIO, scheme, switch, transformer

from dacToSim.DataModel.Converters.DeviceRules import DeviceRules
from dacToSim.DataModel.Device.Declaration import DeviceDeclaration

from dacToSim.constants.projectTypes import REMOTE_IO

from dacToSim.DataModel.Converters.common.pairings import getPairing


mappingRules = {
  'SIM_BKR':	breaker.logicMappingRules,	'SIM_BKR_REMOTE':	breaker.remoteMappingRules,
  'SIM_CONTROL':	scheme.logicMappingRules,	'SIM_CONTROL_REMOTE':	scheme.remoteMappingRules,
  'SIM_DAC_INTERCONNECT':	interconnect.logicMappingRules,	'SIM_DAC_INTERCONNECT_REMOTE':	interconnect.remoteMappingRules,
  'SIM_DAC_INTERCONNECT_MANAGER':	interconnectManager.logicMappingRules,	'SIM_DAC_INTERCONNECT_MANAGER_REMOTE':	interconnectManager.remoteMappingRules,
  'SIM_DG':	dg.logicMappingRules,	'SIM_DG_REMOTE':	dg.remoteMappingRules,

  'SIM_FDR':	circuit.logicMappingRules,	'SIM_FDR_REMOTE':	circuit.remoteMappingRules,
  'SIM_ManSw':	mansw.logicMappingRules,	'SIM_ManSw_REMOTE':	mansw.remoteMappingRules,
  'SIM_PSEUDO_BKR':	breaker.logicMappingRules,	'SIM_PSEUDO_BKR_REMOTE':	breaker.remoteMappingRules,
  'SIM_REC':	recloser.logicMappingRules,	'SIM_REC_REMOTE':	recloser.remoteMappingRules,
  'SIM_SUB_BUS':	bus.logicMappingRules,	'SIM_SUB_BUS_REMOTE':	bus.remoteMappingRules,
  'SIM_SUB_MAIN':	breaker.logicMappingRules,	'SIM_SUB_MAIN_REMOTE':	breaker.remoteMappingRules,
  'SIM_SUB_TIE':	breaker.logicMappingRules,	'SIM_SUB_TIE_REMOTE':	breaker.remoteMappingRules,
  'SIM_SUB_TRANSFORMER':	transformer.logicMappingRules,	'SIM_SUB_TRANSFORMER_REMOTE':	transformer.remoteMappingRules,
  'SIM_SW':	switch.logicMappingRules,	'SIM_SW_REMOTE':	switch.remoteMappingRules,
}

#'SIM_CAP':	logicMappingRules,	'SIM_CAP_REMOTE':	remoteMappingRules,
#'SIM_REG':	logicMappingRules,	'SIM_REG_REMOTE':	remoteMappingRules,
#'SIM_DUAL_SW':	logicMappingRules,	'SIM_DUAL_SW_REMOTE':	remoteMappingRules,



  
def getDeviceRules(device: DeviceDeclaration, projectType: str = REMOTE_IO) -> DeviceRules:
  
  if device.type not in mappingRules:
    raise ValueError(f"Device type {device.type} {projectType} not found in mapping rules.")


  return mappingRules[getPairing(device.type, projectType)]

