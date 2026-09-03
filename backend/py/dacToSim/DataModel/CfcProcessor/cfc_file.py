base='''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>CFC_Test6</Name>
    <POUKind>FunctionBlock</POUKind>
    <ArchivedContent><![CDATA[<?xml version="1.0" encoding="utf-8"?>
<Single xml:space="preserve" Type="{{6f9dac99-8de1-4efc-8465-68ac443b7d08}}" Method="IArchivable">
  <Single Name="Implementation" Type="{{32d3375e-c010-41e2-9e43-b2fbf4f2b374}}" Method="IArchivable">
    <Single Name="Items" Type="{{cd57ba20-558b-4b98-96c1-73c6000c3087}}" Method="IArchivable">
      <List2 Name="InnerList">
				{inputs}
				{outputs}
				{pouCalls}
				{connections}
				{comments}
      </List2>
    </Single>
  </Single>
  <Single Name="Interface" Type="{{a9ed5b7e-75c5-4651-af16-d2c27e98cb94}}" Method="IArchivable">
    <Single Name="TextDocument" Type="{{f3878285-8e4f-490b-bb1b-9acbb7eb04db}}" Method="IArchivable">
      <Single Name="TextBlobForSerialisation" Type="string">FUNCTION_BLOCK SIM_CFC
VAR
END_VAR
</Single>
      <Single Name="LineInfoPersistence" Type="string">2057341f-894e-427f-a46e-5cdf63d218a5_Decl_LineIds</Single>
    </Single>
  </Single>
  <Single Name="UniqueIdGenerator" Type="string">59</Single>
  <Single Name="POULevel" Type="{{8e575c5b-1d37-49c6-941b-5c0ec7874787}}">Standard</Single>
  <List Name="ChildObjectGuids" Type="System.Collections.ArrayList" />
  <Single Name="AddAttributeSubsequent" Type="bool">False</Single>
</Single>]]></ArchivedContent>
  </POU>
</RTACModule>'''

POUKINDS = {'FunctionBlock':'FUNCTION_BLOCK', 'Program':'PROGRAM', 'function':'FUNCTION'}



from typing import List
from dacToSim.DataModel.CfcProcessor.Objects import CFC_SOURCE, CFC_SINK, POU_CALL, Comment, Connection, connMarkSink, connMarkSource
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.etree.ElementTree import Element, SubElement, tostring

from dacToSim.Builders.Master.AreaMap.convert import Declaration, DeclarationGroup, getExistingDeclaration

import html



class RTAC_CFC_PARSER:
  def __init__(self):
    self.root : Element = None

  def findTagNamePair(self, tag:str, name:str) -> Element:
    if self.root is None:
      raise ValueError("Root element is not set. Call fromXml() first.")

    return self.root.find(f".//{tag}[Name='{name}']")


class cfc_file:
  def __init__(self, pouKind:str='FunctionBlock'):
    self.pou_name: str = ""
    self.pouKind: str = pouKind if pouKind in POUKINDS else 'FunctionBlock'

    self.declarations: List[DeclarationGroup] = []

    self.pouCalls: List[POU_CALL] = []
    self.setIdGenerator()
    self.sources: List[CFC_SOURCE] = []
    self.sinks: List[CFC_SINK] = []
    self.comments: List[Comment] = []
    self.connections: List[Connection] = []

    self.connSources: List[connMarkSource] = []
    self.connSinks: List[connMarkSink] = []

  def offsetElements(self, xOffset: int=0, yOffset: int=0):
    for source in self.sources:
      source.xPos += xOffset
      source.yPos += yOffset

    for sink in self.sinks:
      sink.xPos += xOffset
      sink.yPos += yOffset

    for call in self.pouCalls:
      call.xPos += xOffset
      call.yPos += yOffset

    for comment in self.comments:
      comment.xPos += xOffset
      comment.yPos += yOffset

    for connSource in self.connSources:
      connSource.xPos += xOffset
      connSource.yPos += yOffset

    for connSink in self.connSinks:
      connSink.xPos += xOffset
      connSink.yPos += yOffset

  def fromFile(self, filePath: Path):
    if not filePath.exists():
      raise FileNotFoundError(f"File {filePath} does not exist.")

    with open(filePath, 'r', encoding='utf-8') as file:
      content = file.read()
   
    self.declarations = getExistingDeclaration(content)

    # Parse the XML content and populate the object attributes
    self.fromXml(ET.fromstring(content))

    return self
  
  def fromXml(self, element: Element):
    self.pou_name = element.find('POU').find('Name').text  
    self.pouKind = element.find('POU').find('POUKind').text
    archivedContent = html.unescape(element.find('POU').find('ArchivedContent').text)

    innerRoot = ET.fromstring(archivedContent)
    
    implementation = innerRoot.find(f".//*[@Name='Implementation']").find(f".//*[@Name='Items']").find('List2').findall('Single')
    

    # Parse inputs, outputs, pou_calls, connections and comments
    # filter elements based on their type GUID
    for elem in implementation:
      if elem.get('Type') == CFC_SOURCE.rootType:
        self.sources.append(CFC_SOURCE(self.idGenerator).fromXml(elem))

    for elem in implementation:
      if elem.get('Type') == CFC_SINK.rootType:
        self.sinks.append(CFC_SINK(self.idGenerator).fromXml(elem))

    for elem in implementation:
      if elem.get('Type') == POU_CALL.rootType:
        self.pouCalls.append(POU_CALL(self.idGenerator).fromXml(elem))

    for elem in implementation:
      if elem.get('Type') == Connection.rootType:
        self.connections.append(Connection(self.idGenerator).fromXml(elem))

    for elem in implementation:
      if elem.get('Type') == Comment.rootType:
        self.comments.append(Comment(self.idGenerator).fromXml(elem))

    for elem in implementation:
      if elem.get('Type') == connMarkSource.rootType:
        self.connSources.append(connMarkSource(self.idGenerator).fromXml(elem))

    for elem in implementation:
      if elem.get('Type') == connMarkSink.rootType:
        self.connSinks.append(connMarkSink(self.idGenerator).fromXml(elem))

    return self

  def _toArchivedString(self) -> str:
    # Build the XML structure that is expected in the ArchivedContent
    element = Element('Single', Type="{6f9dac99-8de1-4efc-8465-68ac443b7d08}", Method="IArchivable")
    
    element.set('xml:space', 'preserve')
    implementation = SubElement(element, 'Single', Name='Implementation', Type="{32d3375e-c010-41e2-9e43-b2fbf4f2b374}", Method="IArchivable")
    items = SubElement(implementation, 'Single', Name='Items', Type="{cd57ba20-558b-4b98-96c1-73c6000c3087}", Method="IArchivable")
    innerList = SubElement(items, 'List2', Name='InnerList')

    for elem in self.sources:
      innerList.append(elem.toXml())
    for elem in self.sinks:
      innerList.append(elem.toXml()) 
    for elem in self.connSources:
      innerList.append(elem.toXml())
    for elem in self.connSinks:
      innerList.append(elem.toXml())    
    for elem in self.pouCalls:
      innerList.append(elem.toXml())
    for elem in self.connections:
      innerList.append(elem.toXml())

    for elem in self.comments:
      innerList.append(elem.toXml())

    varDeclarations : List[str] = [group.write() for group in self.declarations if group.declarations]

    interface = SubElement(element, 'Single', Name='Interface', Type="{a9ed5b7e-75c5-4651-af16-d2c27e98cb94}", Method="IArchivable")
    textDocument = SubElement(interface, 'Single', Name='TextDocument', Type="{f3878285-8e4f-490b-bb1b-9acbb7eb04db}", Method="IArchivable")
    SubElement(textDocument, 'Single', Name='TextBlobForSerialisation', Type='string').text = f'{POUKINDS[self.pouKind]} ' + self.pou_name + "\n" + "\n".join(varDeclarations) + "\n"
    SubElement(textDocument, 'Single', Name='LineInfoPersistence', Type='string').text = "2057341f-894e-427f-a46e-5cdf63d218a5_Decl_LineIds"
    #SubElement(element, 'Single', Name='UniqueIdGenerator', Type='string').text = "59"
    SubElement(element, 'Single', Name='POULevel', Type="{8e575c5b-1d37-49c6-941b-5c0ec7874787}").text = "Standard"
    SubElement(element, 'List', Name='ChildObjectGuids', Type='System.Collections.ArrayList')
    SubElement(element, 'Single', Name='AddAttributeSubsequent', Type='bool').text = "False"

    ET.indent(element, space="  ", level=0)

    return f"<![CDATA[{ET.tostring(element, encoding='unicode', method='xml')}]]>"
      

  def toXml(self) -> Element:
    # Create the root element
    root = Element('RTACModule')
    
    # Create the POU element
    pou = SubElement(root, 'POU')
    SubElement(pou, 'Name').text = self.pou_name
    SubElement(pou, 'POUKind').text = self.pouKind
    
    # Add the archived content
    archivedContent = SubElement(pou, 'ArchivedContent')

    archivedContent.text = self._toArchivedString()

    ET.indent(root, space="  ", level=0)

    return root
  

  def toString(self) -> str:
    # Convert the XML tree to a string
    return html.unescape(ET.tostring(self.toXml(), encoding='unicode', method='xml'))


  def getCallsOfType(self, pouName:str) -> List[POU_CALL]:
    return [call for call in self.pouCalls if pouName.upper() in call.callName.upper()]
  


  # Create a localized ID generator function
  # It is to have a used IDs that are passed into the function
  # IF value is in the cache, it will return that value
  # otherwise it will generate a new ID
  def setIdGenerator(self):
    usedIds = set()
    lastAssignedId = 0
    
    def idGenerator(id=0):
      nonlocal lastAssignedId, usedIds
      if id > 0:
        usedIds.add(id)
        return id
      
      if id == 0:
        id = lastAssignedId + 1

      while id in usedIds:
        id += 1
      
      lastAssignedId = id
      return id
    
    self.idGenerator = idGenerator
    return self.idGenerator
  
  def getDeclarationGroup(self, groupName: str) -> DeclarationGroup:    
    for group in self.declarations:
      if group.name.upper() == groupName.upper():
        return group
  
def printLines(value:str, maxLines:int = 10) -> str:
  lines = value.split('\n')
  if len(lines) > maxLines:
    print('\n'.join(lines[:maxLines]) + '\n...')
  print(value)
