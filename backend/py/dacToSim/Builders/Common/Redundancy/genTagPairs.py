import xml.etree.ElementTree as ET
from typing import List
from pathlib import Path


from dacToSim.DataModel.Device.Connections import ConnectionFiles


from dacToSim.DataModel.FileTemplates import  programTemplate
from dacToSim.common import writeFile


class TagProperties:
  def __init__(self, tagName:str, pointNumber:int):
    parts = tagName.split('.')
    if len(parts) > 1:
      self.tagName = parts[1]
    else:
      self.tagName = parts[0]

    self.pointNumber = pointNumber
    
def getFirstTagName(path:Path, settingPage:str) -> str:
  ''' Extract tag names from the file at the given path using xml parsing. '''
  # Example is xml layout, adjust as necessary
  tree = ET.parse(path)
  root = tree.getroot()
  tagNames : List[TagProperties] = []
  for device in root.findall('.//Device'):
    for settingPages in device.findall(f'.//SettingPage[Name="{settingPage}"]'):
      for row in settingPages.findall('.//Row'):
        tagName = row.find('.//Setting[Column="Tag Name"]/Value')
        pointNumber = row.find('.//Setting[Column="Point Number"]/Value')
        if tagName is not None and tagName.text and pointNumber is not None and pointNumber.text:
          tagNames.append(TagProperties(tagName.text, int(pointNumber.text)))

  first = tagNames[0] if tagNames else None
  if first:
    for tag in tagNames:
      if tag.pointNumber < first.pointNumber:
        first = tag
  return first.tagName


def genTagPairs(pouName:str, dacIpAddrs : str|List[str], scadaMaps : List[ConnectionFiles]) -> str :

  ''' Generate the tag pair code for the master gateway '''
  if isinstance(dacIpAddrs, str) or len(dacIpAddrs) <= 1 or not scadaMaps:
    # If there's only one IP address or a single string, no redundancy is needed
    return None
  
  implRedundantConnections : List[str] = ['TagSymbolCheck();','']
  for scadaMap in scadaMaps:
    firstTagName = getFirstTagName(scadaMap.tagMap.path, 'Binary Inputs')

    priTag = f"{scadaMap.tagMap.GetName(0)}_DNP.{firstTagName}"
    secTag = f"{scadaMap.tagMap.GetName(1)}_DNP.{firstTagName}"

    implRedundantConnections.append(
      f'SetRedundantScadaPair(	pScadaTag1:= ADR({priTag}),	pScadaTag2:= ADR({secTag}));'
    )

  return programTemplate.format(
    pouName=pouName,
    decl='',
    impl='\n'.join(implRedundantConnections)
  )

def getTagSymbolCheck() -> str:
  return '''<RTACModule>
  <LogicEngineObject>
    <Name>TagSymbolCheck</Name>
    <Type>Program</Type>
    <Interface><![CDATA[PROGRAM TagSymbolCheck]]></Interface>
    <Implementation><![CDATA[{IF (defined (type: _ABCD_1234_Tag_Info)) AND (defined (type: _ABCD_1234_Connection_Tag_Info)) AND (defined (variable: _ABCD_1234_TagSymbolTable._ABCD_1234_connections))}
g_TagSymbolTableManager.SetConnectionTable(
	pConnectionTable:= ADR(_ABCD_1234_TagSymbolTable._ABCD_1234_connections), 
	iConnectionTableLen:= SIZEOF(_ABCD_1234_TagSymbolTable._ABCD_1234_connections)/SIZEOF(Connection_Tag_Info), 
	bUseConnectionTable:= (SIZEOF(Tag_Info) = SIZEOF(_ABCD_1234_Tag_Info)) AND (SIZEOF(Connection_Tag_Info) = SIZEOF(_ABCD_1234_Connection_Tag_Info))
	);
	g_TagSymbolTableManager.BypassChecks := NOT (SIZEOF(Tag_Info) = SIZEOF(_ABCD_1234_Tag_Info)) AND (SIZEOF(Connection_Tag_Info) = SIZEOF(_ABCD_1234_Connection_Tag_Info));
{END_IF}]]></Implementation>
    <Metadata><![CDATA[<Single xml:space="preserve" Type="{81297157-7ec9-45ce-845e-84cab2b88ade}" Method="IArchivable">
  <Dictionary Type="{2c41fa04-1834-41c1-816e-303c7aa2c05b}" Name="Properties" />
  <Single Name="TypeGuid" Type="System.Guid">6f9dac99-8de1-4efc-8465-68ac443b7d08</Single>
</Single>]]></Metadata>
  </LogicEngineObject>
</RTACModule>'''



        