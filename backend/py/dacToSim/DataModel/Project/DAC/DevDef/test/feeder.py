test = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>DevDef_Feeder</Name>
    <Content><![CDATA[VAR_GLOBAL
	//Templates for each scheme object. Tag inputs should be assigned the point map index they correspond to. Unused inputs should be assigned negative one.
	FdrDef_Standard :typeFeederDeviceDef := (			
		TypeName:=	'Fdr Standard'	,
		IsolateBreakerZone:=	FALSE	,
		AllowSelectLevel1:=	FALSE	,
		AllowRestoreLevel1:=	FALSE	,
		
		// Field Statuses
		SCADA_FeederArmed_Index	:= 0,	(* Feeder is armed and ready to response to event *)
		SCADA_FeederAbnormal_Index	:= 1,	(* An abnormal condition exists on equipment associated with feeder *)
		SCADA_Excluded_Index	:= 2,	
		SCADA_FeederLoop_Index	:= 3,	(* An loopl condition has been confirmed on feeder *)
		SCADA_FeederEvent_Index	:= 4,	(* An event has been detected on feeder *)
		SCADA_FeederFault_Index	:= 5,	(* A fault has been confirmed on feeder *)
		SCADA_FeederOpenPhase_Index	:= 6,	(* An open phase condition has been confirmed on feeder *)
		SCADA_FeederMiscoordination_Index	:= 7,	(* An miscoordination condition has been confirmed on feeder *)
		SCADA_FeederOverload_Index	:= 8,	(* An overload condition has been confirmed on feeder *)
		SCADA_OverloadWarning_Index	:= 9,	(* An overload condition has been detected on feeder *)
		SCADA_FeederUpdate_Index	:= 10,	
		SCADA_FeederAnalyze_Index	:= 11,	
		SCADA_FeederReturn_Index	:= 12,	
		SCADA_FeederUpdateTimeout_Index	:= 13,	
		SCADA_FeederAnalyzeTimeout_Index	:= 14,	
		SCADA_FeederSourceEvent_Index	:= 15,	(* A fault has been confirmed on source side of the circuit *)
		SCADA_ReconfigurationStarted_Index	:= 16,	(* An event on the feeder has resulted in starting a reconfiguration *)
		SCADA_ReconfigurationComplete_Index	:= 17,	(* The reconfiguration actions have been completed - will reset automatically after 10 minutes *)
		SCADA_RestorationFail_Index	:= 18,	(* The reconfiguration was unsucessful in restoring all load - will reset automatically after 10 minutes *)
		SCADA_CapacityLimit_Index	:= 19,	(* AR solution resulted in above temporary capacity limits, load not being restored, and/or load shed *)
		SCADA_AbnormalFailure_Index	:= 20,	(* AR solution was aborted due to abnormal conditions on the event feeder *)
		SCADA_VoltageLimit_Index	:= 21,	(* AR solution was not executed to completion due to voltage being less than the live threshold or phase incompatibilities *)
		SCADA_CommandFailure_Index	:= 22,	(* AR solution was not executed to completion due to no response to a command *)
		SCADA_LossOfSource_Index	:= 23,	(* Indication that a loss of source was confirmed on the circuit. *)
		SCADA_FeederReady_Index	:= 24,	(* Indication that the feeder is ready to operate. Combination of Armed and Abnormal Status. *)
		SCADA_ExcludedByUnderfrequency_Index := 25, (*UnderFrequency Latch*)
	
		SCADA_ExcludeCmd_Index	:= 0,	(* Turn off Automation for this circuit *)
		SCADA_IncludeCmd_Index	:= 0,	(* Turn on automation for this circuit *)
		SCADA_ReturnNormalCmd_Index	:= 1,	
		SCADA_LossOfSourceRestoreCmd_Index	:= -1
	);

  FdrDef_Standard2 :typeFeederDeviceDef := (			
		TypeName:=	'Fdr Standard'	,
		IsolateBreakerZone:=	FALSE	,
		AllowSelectLevel1:=	FALSE	,
		AllowRestoreLevel1:=	FALSE	,
		
		// Field Statuses
		SCADA_FeederArmed_Index	:= 0,	(* Feeder is armed and ready to response to event *)
		SCADA_FeederAbnormal_Index	:= 1,	(* An abnormal condition exists on equipment associated with feeder *)
		SCADA_Excluded_Index	:= 2,	
		SCADA_FeederLoop_Index	:= 3,	(* An loopl condition has been confirmed on feeder *)
		SCADA_FeederEvent_Index	:= 4,	(* An event has been detected on feeder *)
		SCADA_FeederFault_Index	:= 5,	(* A fault has been confirmed on feeder *)
		SCADA_FeederOpenPhase_Index	:= 6,	(* An open phase condition has been confirmed on feeder *)
		SCADA_FeederMiscoordination_Index	:= 7,	(* An miscoordination condition has been confirmed on feeder *)
		SCADA_FeederOverload_Index	:= 8,	(* An overload condition has been confirmed on feeder *)
		SCADA_OverloadWarning_Index	:= 9,	(* An overload condition has been detected on feeder *)
		SCADA_FeederUpdate_Index	:= 10,	
		SCADA_FeederAnalyze_Index	:= 11,	
		SCADA_FeederReturn_Index	:= 12,	
		SCADA_FeederUpdateTimeout_Index	:= 13,	
		SCADA_FeederAnalyzeTimeout_Index	:= 14,	
		SCADA_FeederSourceEvent_Index	:= 15,	(* A fault has been confirmed on source side of the circuit *)
		SCADA_ReconfigurationStarted_Index	:= 16,	(* An event on the feeder has resulted in starting a reconfiguration *)
		SCADA_ReconfigurationComplete_Index	:= 17,	(* The reconfiguration actions have been completed - will reset automatically after 10 minutes *)
		SCADA_RestorationFail_Index	:= 18,	(* The reconfiguration was unsucessful in restoring all load - will reset automatically after 10 minutes *)
		SCADA_CapacityLimit_Index	:= 19,	(* AR solution resulted in above temporary capacity limits, load not being restored, and/or load shed *)
		SCADA_AbnormalFailure_Index	:= 20,	(* AR solution was aborted due to abnormal conditions on the event feeder *)
		SCADA_VoltageLimit_Index	:= 21,	(* AR solution was not executed to completion due to voltage being less than the live threshold or phase incompatibilities *)
		SCADA_CommandFailure_Index	:= 22,	(* AR solution was not executed to completion due to no response to a command *)
		SCADA_LossOfSource_Index	:= 23,	(* Indication that a loss of source was confirmed on the circuit. *)
		SCADA_FeederReady_Index	:= 24,	(* Indication that the feeder is ready to operate. Combination of Armed and Abnormal Status. *)
		SCADA_ExcludedByUnderfrequency_Index := 25, (*UnderFrequency Latch*)
	
		SCADA_ExcludeCmd_Index	:= 0,	(* Turn off Automation for this circuit *)
		SCADA_IncludeCmd_Index	:= 0,	(* Turn on automation for this circuit *)
		SCADA_ReturnNormalCmd_Index	:= 1,	
		SCADA_LossOfSourceRestoreCmd_Index	:= -1
	);
END_VAR
]]></Content>
  </GVL>
</RTACModule>'''



