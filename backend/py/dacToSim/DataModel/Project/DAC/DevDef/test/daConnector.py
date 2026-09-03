test = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>DevDef_DA_Connector</Name>
    <Content><![CDATA[ VAR_GLOBAL
   DA_Connector:typeDacInterconnectDeviceDef := (
        TypeName:= 'Test',
        UpdateTimeLimit:= T#20S,
        SCADA_Abnormal_Index:= 0,
        SCADA_CommAlarm_Index:= 1,
        SCADA_ControlSequenceFailure_Index:=2);
       
       
    DA_Manager:typeDacInterconnectManagerDeviceDef := (
        WdogTimeout:= T#5S ,
        AnalyzeWdogTimeout:= T#45S ,
        SCADA_RemoteDacCommFail_Index:= 0,
        SCADA_RemoteDacEnabled_Index:= 1);
       
END_VAR
 ]]></Content>
  </GVL>
</RTACModule>'''