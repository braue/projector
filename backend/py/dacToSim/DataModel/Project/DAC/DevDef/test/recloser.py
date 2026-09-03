test = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>DevDef_Recloser</Name>
    <Content><![CDATA[VAR_GLOBAL
//Templates for each scheme object. Tag inputs should be assigned the point map index they correspond to. Unused inputs should be assigned negative one.
	RecDef_Standard :typeRecloserDeviceDef := (
		TypeName:=	'Rec Standard'	,
		StatusUses52A:=	TRUE	,
		Normal_Remote:=	TRUE	,
		Normal_HotLineTag:=	FALSE	,
		Normal_Reclose:=	TRUE	,
		
		// Statuses
		Status_Index:=	0	,
		Remote_Index:=	33	,
		Reclose_INDEX:=	5	,
		Fault_Index:=	36	,
		Lockout_INDEX:=	17	,
		Trouble_Index:=	19	,
		SG1_INDEX:=	34	,
		SG2_INDEX:=	35	,
		FrequencyLockout_Index:= 37,
		Set1_59N_Index:=	41	,
		Set2_59N_Index:=	42	,

		// Analogs
		CurrentA_Index:=	0	,
		CurrentB_Index:=	1	,
		CurrentC_Index:=	2	,
		ReactivePower_Index:=	14	,
		RealPower_Index:=	10	,
		VoltageSet1A_INDEX:=	4	,
		VoltageSet1B_INDEX:=	5	,
		VoltageSet1C_INDEX:=	6	,
		VoltageSet2A_INDEX:=	7	,
		VoltageSet2B_INDEX:=	8	,
		VoltageSet2C_INDEX:=	9	,
		
		ScalePQ_DAC:=	10	,
		ScaleVoltage_DAC:=	100	,
		ScaleCurrent_DAC:=	0.1	,
		ScalePQ_SIM:=	0.1	,
		ScaleVoltage_SIM:=	0.01	,
		ScaleCurrent_SIM:=	10	,
		
		// Controls
		OpenCmd_Index:=	4	,
		CloseCmd_Index:=	4	,
		FaultResetCmd_Index:=	2	,
		SS1Cmd_INDEX:=	0	,
		SS2Cmd_INDEX:=	1	,
		
		// SCADA Statuses
		SCADA_CmdTimeout_INDEX:=	80	,
		SCADA_CommAlarm_INDEX:=	81	,
		SCADA_Abnormal_INDEX:=	82	,
		SCADA_DeadA_INDEX:=		83,
		SCADA_LiveA1_INDEX:= 	84,	
		SCADA_DeadB_INDEX:=		85,
		SCADA_LiveB1_INDEX:= 	86,	
		SCADA_InhibitControl_INDEX:=	87	,
		SCADA_Bypass_INDEX:=	88	,
		SCADA_OutOfService_INDEX:=	89	,


		// SCADA Controls
		SCADA_EnableInhibitControlCmd_Index:=	34	,
		SCADA_DisableInhibitControlCmd_Index:=	34	,
		SCADA_EnableBypassCmd_Index:=	35	,
		SCADA_DisableBypassCmd_Index:=	35	,
		SCADA_EnableOutOfServiceCmd_Index:=	36	,
		SCADA_DisableOutOfServiceCmd_Index:=	36	
	);
	
	//RECCLOSER with COMM FAIL
	RecDef_Standard_withCommFail :typeRecloserDeviceDef := (
		TypeName:=	'Rec Standard'	,
		StatusUses52A:=	TRUE	,
		Normal_Remote:=	TRUE	,
		Normal_HotLineTag:=	FALSE	,
		Normal_Reclose:=	TRUE	,
		Normal_CommStatus:= FALSE	,
		
		// Statuses
		Status_Index:=	0	,
		Remote_Index:=	33	,
		Reclose_INDEX:=	5	,
		Fault_Index:=	36	,
		Lockout_INDEX:=	17	,
		Trouble_Index:=	19	,
		SG1_INDEX:=	34	,
		SG2_INDEX:=	35	,
		FrequencyLockout_Index:= 37,
		Set1_59N_Index:=	41	,
		Set2_59N_Index:=	42	,
		CommStatus_Index:= 43,

		// Analogs
		CurrentA_Index:=	0	,
		CurrentB_Index:=	1	,
		CurrentC_Index:=	2	,
		ReactivePower_Index:=	14	,
		RealPower_Index:=	10	,
		VoltageSet1A_INDEX:=	4	,
		VoltageSet1B_INDEX:=	5	,
		VoltageSet1C_INDEX:=	6	,
		VoltageSet2A_INDEX:=	7	,
		VoltageSet2B_INDEX:=	8	,
		VoltageSet2C_INDEX:=	9	,
		
		ScalePQ_DAC:=	10	,
		ScaleVoltage_DAC:=	100	,
		ScaleCurrent_DAC:=	0.1	,
		ScalePQ_SIM:=	0.1	,
		ScaleVoltage_SIM:=	0.01	,
		ScaleCurrent_SIM:=	10	,
		
		// Controls
		OpenCmd_Index:=	4	,
		CloseCmd_Index:=	4	,
		FaultResetCmd_Index:=	2	,
		SS1Cmd_INDEX:=	0	,
		SS2Cmd_INDEX:=	1	,
		
		// SCADA Statuses
		SCADA_CmdTimeout_INDEX:=	80	,
		SCADA_CommAlarm_INDEX:=	81	,
		SCADA_Abnormal_INDEX:=	82	,
		SCADA_DeadA_INDEX:=		83,
		SCADA_LiveA1_INDEX:= 	84,	
		SCADA_DeadB_INDEX:=		85,
		SCADA_LiveB1_INDEX:= 	86,	
		SCADA_InhibitControl_INDEX:=	87	,
		SCADA_Bypass_INDEX:=	88	,
		SCADA_OutOfService_INDEX:=	89	,


		// SCADA Controls
		SCADA_EnableInhibitControlCmd_Index:=	34	,
		SCADA_DisableInhibitControlCmd_Index:=	34	,
		SCADA_EnableBypassCmd_Index:=	35	,
		SCADA_DisableBypassCmd_Index:=	35	,
		SCADA_EnableOutOfServiceCmd_Index:=	36	,
		SCADA_DisableOutOfServiceCmd_Index:=	36	
	);
	
	RecDef_Standard_Forest_Hill :typeRecloserDeviceDef := (
		TypeName:=	'Rec Standard'	,
		StatusUses52A:=	TRUE	,
		Normal_Remote:=	TRUE	,
		Normal_HotLineTag:=	FALSE	,
		Normal_Reclose:=	TRUE	,
		
		// Statuses
		Status_Index:=	0	,
		Remote_Index:=	33	,
		Reclose_INDEX:=	5	,
		Fault_Index:=	36	,
		Lockout_INDEX:=	17	,
		Trouble_Index:=	19	,
		SG1_INDEX:=	34	,
		SG2_INDEX:=	35	,
		FrequencyLockout_Index:= 37,
		Set1_59N_Index:=	41	,
		Set2_59N_Index:=	42	,

		// Analogs
		CurrentA_Index:=	0	,
		CurrentB_Index:=	1	,
		CurrentC_Index:=	2	,
		ReactivePower_Index:=	14	,
		RealPower_Index:=	10	,
		VoltageSet1A_INDEX:=	4	,
		VoltageSet1B_INDEX:=	5	,
		VoltageSet1C_INDEX:=	6	,
		VoltageSet2A_INDEX:=	7	,
		VoltageSet2B_INDEX:=	8	,
		VoltageSet2C_INDEX:=	9	,
		
		ScalePQ_DAC:=	10	,
		ScaleVoltage_DAC:=	100	,
		ScaleCurrent_DAC:=	0.1	,
		ScalePQ_SIM:=	0.1	,
		ScaleVoltage_SIM:=	0.01	,
		ScaleCurrent_SIM:=	10	,
		
		// Controls
		OpenCmd_Index:=	4	,
		CloseCmd_Index:=	4	,
		FaultResetCmd_Index:=	2	,
		SS1Cmd_INDEX:=	0	,
		SS2Cmd_INDEX:=	1	,
		
		// SCADA Statuses
		SCADA_CmdTimeout_INDEX:=	65	,
		SCADA_CommAlarm_INDEX:=	66	,
		SCADA_Abnormal_INDEX:=	67	,
		SCADA_DeadA_INDEX:=	68	,
		SCADA_LiveA1_INDEX:= 	69	,
		SCADA_DeadB_INDEX:=	70	,
		SCADA_LiveB1_INDEX:= 	71	,
		SCADA_InhibitControl_INDEX:=	72	,
		SCADA_Bypass_INDEX:=	73	,
		SCADA_OutOfService_INDEX:=	74	,

		// SCADA Controls
		SCADA_EnableInhibitControlCmd_Index:=	34	,
		SCADA_DisableInhibitControlCmd_Index:=	34	,
		SCADA_EnableBypassCmd_Index:=	35	,
		SCADA_DisableBypassCmd_Index:=	35	,
		SCADA_EnableOutOfServiceCmd_Index:=	36	,
		SCADA_DisableOutOfServiceCmd_Index:=	36	
	);
	
	//RECCLOSER with COMM FAIL
	RecDef_Standard_withCommFail_Forest_Hill :typeRecloserDeviceDef := (
		TypeName:=	'Rec Standard'	,
		StatusUses52A:=	TRUE	,
		Normal_Remote:=	TRUE	,
		Normal_HotLineTag:=	FALSE	,
		Normal_Reclose:=	TRUE	,
		Normal_CommStatus:= FALSE	,
		
		// Statuses
		Status_Index:=	0	,
		Remote_Index:=	33	,
		Reclose_INDEX:=	5	,
		Fault_Index:=	36	,
		Lockout_INDEX:=	17	,
		Trouble_Index:=	19	,
		SG1_INDEX:=	34	,
		SG2_INDEX:=	35	,
		FrequencyLockout_Index:= 37,
		Set1_59N_Index:=	41	,
		Set2_59N_Index:=	42	,
		CommStatus_Index:= 43,

		// Analogs
		CurrentA_Index:=	0	,
		CurrentB_Index:=	1	,
		CurrentC_Index:=	2	,
		ReactivePower_Index:=	14	,
		RealPower_Index:=	10	,
		VoltageSet1A_INDEX:=	4	,
		VoltageSet1B_INDEX:=	5	,
		VoltageSet1C_INDEX:=	6	,
		VoltageSet2A_INDEX:=	7	,
		VoltageSet2B_INDEX:=	8	,
		VoltageSet2C_INDEX:=	9	,
		
		ScalePQ_DAC:=	10	,
		ScaleVoltage_DAC:=	100	,
		ScaleCurrent_DAC:=	0.1	,
		ScalePQ_SIM:=	0.1	,
		ScaleVoltage_SIM:=	0.01	,
		ScaleCurrent_SIM:=	10	,
		
		// Controls
		OpenCmd_Index:=	4	,
		CloseCmd_Index:=	4	,
		FaultResetCmd_Index:=	2	,
		SS1Cmd_INDEX:=	0	,
		SS2Cmd_INDEX:=	1	,
		
		// SCADA Statuses
		SCADA_CmdTimeout_INDEX:=	65	,
		SCADA_CommAlarm_INDEX:=	66	,
		SCADA_Abnormal_INDEX:=	67	,
		SCADA_DeadA_INDEX:=	68	,
		SCADA_LiveA1_INDEX:= 	69	,
		SCADA_DeadB_INDEX:=	70	,
		SCADA_LiveB1_INDEX:= 	71	,
		SCADA_InhibitControl_INDEX:=	72	,
		SCADA_Bypass_INDEX:=	73	,
		SCADA_OutOfService_INDEX:=	74	,

		// SCADA Controls
		SCADA_EnableInhibitControlCmd_Index:=	34	,
		SCADA_DisableInhibitControlCmd_Index:=	34	,
		SCADA_EnableBypassCmd_Index:=	35	,
		SCADA_DisableBypassCmd_Index:=	35	,
		SCADA_EnableOutOfServiceCmd_Index:=	36	,
		SCADA_DisableOutOfServiceCmd_Index:=	36	
	);
END_VAR]]></Content>
  </GVL>
</RTACModule>'''