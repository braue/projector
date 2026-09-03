devDec = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <ExportSource>
      <Schema>35</Schema>
      <DeviceMOT>3555</DeviceMOT>
    </ExportSource>
    <Name>DeviceDeclarations</Name>
    <Content><![CDATA[VAR_GLOBAL
	
	DA_Controller	:	DA_Control;														
	
	//Mansfield Carrol-Clarence																
	F5001	,	F5071	,	F5087	,	F5100	,	F5203	,	F5257	,	F5310	,	FN2358	:	DA_FDR;									
																	
	B5001	,	B5071	,	B5087	,	B5100	,	B5203	,	B5257	,	B5310	,	BN2358	:	DA_PSEUDO_BKR;									
																	
	R1090	,	R1206	,	R1224	,	R1283	,	R1473	,	R1880	,	R1881	,	R5013	:	DA_REC;
	R5014	,	R5019	,	R5022	,	R5025	,	R5026	,	R5027	,	R5029	,	R5069	:	DA_REC;
	R5092	,	R5112	,	R5118	,	R5119	,	R5122	,	R5123	,	R5131	,	R5140	:	DA_REC;
	R5157	,	R5182	,	R5189	,	R5218	,	R5219	,	R5262	,	R5798	,	R5073	:	DA_REC;
	R5018	,   R5052   :	DA_REC;
										
	//Mansfield Many
	F5240	,	F5241	,	F5242	:	DA_FDR;			

	B5240	,	B5241	,	B5242	:	DA_PSEUDO_BKR;		

	R5045	,	R5222	,	R5228	,	R5232	,	R5249	,	R5251	,	R5255	,	R5260	:	DA_REC;
	R5264	,	R5268	,	R5274	,	R5279	,	R5280	,	R5293	,	R5298	,	R5299	:	DA_REC;
	R5350	,	R5354	,	R5358	:	DA_REC;		
	
   // Mansfield - Many - 2021 - Phase 3 Additions
   F5202	:	DA_FDR;
   
   B5202	:	DA_PSEUDO_BKR;
   
   R1009	,	R1142	,	R1228	,	R2510	,	R5187	,	R5188	,	R5195	,	R5206	:	DA_REC;
   R5208	,	R5210	,	R5215	,	R5266	,	R5270	,	R5271	,	R5794	:	DA_REC;		

   
	
	
	//DA Connector
	R5299_Connector : DA_DAC_INTERCONNECT;
	Rosepine_Mansfield_Manager : DA_DAC_INTERCONNECT_MANAGER;	

ScreenNum : int := 0;
											
END_VAR]]></Content>
  </GVL>
</RTACModule>'''




nameConversions = [
  {'old':'DA_Controller','new':'Mansfield_Controller'}
]