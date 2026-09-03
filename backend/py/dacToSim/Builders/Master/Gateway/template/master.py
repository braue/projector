masterTemplate = """<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>Gateway</Name>
    <POUKind>Program</POUKind>
    <Content>
      <Interface><![CDATA[PROGRAM Gateway
VAR
	ManualReset :BOOL := FALSE;

	// DAC IP addresses
{decDacIps}

	// SIM IP addresses
{decSimIps}

	{decHeadIp}
END_VAR
VAR
{decSimPortPreFix}
END_VAR
VAR
{decGateway}
END_VAR
VAR CONSTANT
{maxDacs}
END_VAR]]></Interface>
      <Implementation><![CDATA[{implRedundantConnections}
GatewayConfigurator();															
															
//									              	Gateway Address   		|	Simulated Netmask		
//								               		for Simulated devices	|												
GatewayConfigurator.m_AddNetworkIP(	IP:=	'192.168.199.1',	Netmask:=	'255.255.255.0'	);

IF NOT GatewayConfigurator.Initialized THEN
{implGatewayCalls}
END_IF

IF ManualReset THEN
	GatewayConfigurator.m_Reset();
END_IF]]></Implementation>
    </Content>
  </POU>
</RTACModule>"""