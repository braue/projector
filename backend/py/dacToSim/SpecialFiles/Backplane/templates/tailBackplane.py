from typing import List


template="""<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>Init_RemoteIo</Name>
    <POUKind>Program</POUKind>
    <Content>
      <Interface><![CDATA[PROGRAM Init_RemoteIo
VAR
	SimHead_IP : IpAdrStr:= '{headIp}';
	LocalIp : IpAdrStr := '{remIp}';
END_VAR]]></Interface>
      <Implementation><![CDATA[DA_Simulator.gvl_RemoteIO.Default.Init(
	Name:= '{schemeName}',
	IpMaster:= SimHead_IP,
	IpRem1:= LocalIp,
	IpPort:= 59001
);
DA_Simulator.gvl_RemoteIO.Default.Run();]]></Implementation>
    </Content>
  </POU>
</RTACModule>"""


 
from dacToSim.DataModel.Profile import Scheme


def GetTailBackplane(schemeName:str, simIp:str, headIp:str) -> str:
  if isinstance(headIp, List):
    headIp = headIp[0]  # Use the first IP if multiple are provided
  if isinstance(simIp, List):
    simIp = simIp[0]  # Use the first IP if multiple are provided
  return template.format(schemeName=schemeName, remIp=simIp, headIp=headIp)






