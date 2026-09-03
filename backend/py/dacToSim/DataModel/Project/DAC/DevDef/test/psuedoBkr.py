test = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>DevDef_PseudoBkr</Name>
    <Content><![CDATA[VAR_GLOBAL
	PseudoBkr_Std : typePseudoBreakerDeviceDef := (
		TypeName := 'PseudoBreaker',
		SCADA_Status_Index := -1,
		SCADA_FaultLatch_Index := -1,
		SCADA_Lockout_Index := -1,
		SCADA_Abnormal_Index := -1
	
	);
END_VAR
]]></Content>
  </GVL>
</RTACModule>'''