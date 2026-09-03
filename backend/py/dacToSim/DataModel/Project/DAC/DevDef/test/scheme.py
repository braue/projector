test = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>DevDef_Scheme</Name>
    <Content><![CDATA[VAR_GLOBAL
//Templates for each scheme object. Tag inputs should be assigned the point map index they correspond to. Unused inputs should be assigned negative one.
	SchDef_Standard : typeSchemeDeviceDef := (		
		TypeName:=	'Controller Standard'	,
		
		// Statuses
		SCADA_AR_Enabled_Index:=	0	,
		SCADA_Loop_Index:=	1	,
		SCADA_EventDetected_Index:=	2	,
		SCADA_PermanentFault_Index:=	3	,
		SCADA_OpenPhase_Index:=	4	,
		SCADA_Miscoordination_Index:=	5	,
		SCADA_EventConfirmed_Index:=	6	,
		SCADA_UpdateStep_Index:=	7	,
		SCADA_AnalyzeStep_Index:=	8	,
		SCADA_ReconfigureStep_Index:=	9	,
		SCADA_ReturnDetected_Index:=	10	,
		SCADA_CapacityLimit_Index:=	11	,
		SCADA_UpdateStepTimeout_Index:=	12	,
		SCADA_AnalyzeStepTimeout_Index:=	13	,
		SCADA_ReconfigureStepTimeout_Index:=	14	,
		SCADA_AbnormalFailure_Index:=	15	,
		SCADA_VoltageLimit_Index:=	16	,
		SCADA_CommandFailure_Index:=	17	,

    SCADA_PrimaryActive_Index:= 20  , 
    SCADA_SecondaryActive_Index:= 21  , 
    SCADA_PrimaryForcedActive_Index:= 22  , 
    SCADA_SecondaryForcedActive_Index:= 23  , 
    SCADA_RedundancyCommunicationFailure_Index:= 24 ,

              
		SCADA_EventDuration_Index	:=	-1	,	
		SCADA_OverloadSeconds_Index	:=	-1	,	
		SCADA_ShedSeconds_Index	:=	-1	,	
						
						
		SCADA_AR_EnableCmd_Index	:=	0	,	
		SCADA_AR_DisableCmd_Index	:=	0	,	
		SCADA_ResetCmd_Index	:=	1	,
		SCADA_SchemeExcludeCmd_Index	:=	2	,	// Disables the scheme and marks all scheme feeders excluded
		SCADA_SchemeIncludeCmd_Index	:=	2	,	// Enables the scheme and marks all scheme feeders included
		SCADA_ReturnNormalCmd_Index	:=	-1	,

    SCADA_ForcePrimaryActiveCmd_Index:= 4 , 
    SCADA_UnforcePrimaryActiveCmd_Index:= 4 , 
    SCADA_ForceSecondaryActiveCmd_Index:= 5 , 
    SCADA_UnforceSecondaryActiveCmd_Index:= 5

		);
END_VAR
]]></Content>
  </GVL>
</RTACModule>'''