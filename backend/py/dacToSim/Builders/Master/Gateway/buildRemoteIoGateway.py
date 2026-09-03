
from typing import List
from dacToSim.DataModel.Project.Gateway import FieldConnection, ScadaConnection
from .template import remoteIoTemplate

def buildRemoteIoGateway(pouName:str, fieldConnections:List[FieldConnection], scadaConnections: List[ScadaConnection]) -> str:
  implFieldRules = []
  for fieldConnection in sorted(fieldConnections, key=lambda x: x.name):


    implFieldRules.append(
      f'\tGatewayConfigurator.m_AddRoutingRule('	\
      f'\tSimulator_IP:=	SIM_IP,'\
      f'\tSimulator_DNP_Port:=	CONCAT(simPortPrefix[i],\'{fieldConnection.simIpPort[-3:]:03}\'),'\
      f'\tEquipment_Ip:=	\'{fieldConnection.equipIpAddr}\','\
      f'\tEquipment_DNP_Port:=	\'{fieldConnection.equipIpPort}\','\
      f'\tDAC_IP:=	DAC_IP[i]	);'\
      f'\t// {fieldConnection.name}'
    )

  implScadaRules = []
  for scadaConnection in sorted(scadaConnections, key=lambda x: x.name):
    implScadaRules.append(
      f'\tGatewayConfigurator.m_AddScadaDacConnection('\
      f'\tDacIP:=	DAC_IP[i],'\
      f'\tDacDnpPort:=	\'{scadaConnection.srvIpPort}\','\
      f'\tScadaIP:=	\'{scadaConnection.cliIpAddr[0]}\','\
      f'\tSimulator_IP:=	SIM_IP );\t// {scadaConnection.name}'
    )

  if not implFieldRules:
    implFieldRules.append('\t;\t// No Field Connections Defined')

  if not implScadaRules:
    implScadaRules.append('\t;\t// No SCADA Connections Defined')

  return remoteIoTemplate.format(
    pouName=pouName,
    implFieldRules="\n".join(implFieldRules),
    implScadaRules="\n".join(implScadaRules)
  )
