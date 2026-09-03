remoteIoTemplate = """<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>{pouName}</Name>
    <POUKind>FunctionBlock</POUKind>
    <Content>
      <Interface><![CDATA[FUNCTION_BLOCK {pouName}
VAR_IN_OUT
  DAC_IP : ARRAY[*] OF IpAdrStr;
  simPortPrefix : ARRAY[*] OF STRING(2);
END_VAR
VAR_INPUT
  SIM_IP : IpAdrStr	:= '192.168.254.11';
END_VAR
VAR
  i : DINT;
END_VAR]]></Interface>
      <Implementation><![CDATA[// Field connection Routing Rules     
//                                    SimulatorIp               | SimulatorPort                                     | Field Ip                    | Field Port                 |  Polling Controller IP
FOR i := LOWER_BOUND(DAC_IP, 1) TO UPPER_BOUND(DAC_IP, 1) DO
{implFieldRules}
END_FOR

// SCADA connection Routing Rules
FOR i := LOWER_BOUND(DAC_IP, 1) TO UPPER_BOUND(DAC_IP, 1) DO
{implScadaRules}								
END_FOR]]></Implementation>
    </Content>
  </POU>
</RTACModule>"""