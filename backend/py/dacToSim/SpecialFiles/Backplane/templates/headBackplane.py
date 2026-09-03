from typing import List

REMOTE_IO_TEMPLATE = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>{schemeName}_RemoteIo</Name>
    <POUKind>Program</POUKind>
    <Content>
      <Interface><![CDATA[PROGRAM {schemeName}_RemoteIo
VAR
	Manager : class_SimRemoteIO;
END_VAR]]></Interface>
      <Implementation><![CDATA[
Manager.Init(
	Name := '{schemeName}',
	IpMaster := Gateway.Head_SIM_IP,
{remIps}
	IpPort := 59001
);
Manager.Run();]]></Implementation>
    </Content>
  </POU>
</RTACModule>'''

REM_IP_TEMPLATE = "\tIpRem{index} := Gateway.{simIpVarName}[{index}],"


def GetHeadBackplane(schemeName : str, simIpVarName:str, simIps : List[str]|str) -> str:
  remIps = []

  if isinstance(simIps,str):
    simIps=[simIps]
  
  

  for i,val in enumerate(simIps):
    remIps.append(REM_IP_TEMPLATE.format(schemeName=schemeName, simIpVarName=simIpVarName, index=i+1))


  return REMOTE_IO_TEMPLATE.format(schemeName=schemeName, remIps="\n".join(remIps))






