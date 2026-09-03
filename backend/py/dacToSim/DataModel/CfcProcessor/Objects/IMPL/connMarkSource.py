base='''<Single Type="{9e94943e-4951-4da7-a4e2-1f1bb71a6228}" Method="IArchivable">
	<Single Name="Output" Type="{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}" Method="IArchivable">
		<Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
		<Null Name="ElementGroupId" />
		<Single Name="Negated" Type="bool">False</Single>
		<Single Name="SetReset" Type="{24449d48-c96a-49c4-b9d1-a4ea34aedce3}">None</Single>
		<Single Name="SetResetRef" Type="{233bc97c-69fe-4d29-b40e-a9a9b854044e}">None</Single>
		<Single Name="PretendsToBeConnected" Type="bool">False</Single>
		<Single Name="Id" Type="long">3121</Single>
	</Single>
	<Single Name="Text" Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}" Method="IArchivable">
		<Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
		<Null Name="ElementGroupId" />
		<Single Name="Text" Type="string">R5586_R5470</Single>
		<Single Name="Modifiable" Type="bool">True</Single>
		<Single Name="Id" Type="long">3122</Single>
	</Single>
	<Single Name="PageArea" Type="int">0</Single>
	<Single Name="Bounds" Type="string">169, 212, 0, 0</Single>
	<Null Name="ElementGroupId" />
	<Single Name="IsRoutedOver2Editors" Type="bool">False</Single>
	<Single Name="ConnectedSourceHostGuid" Type="System.Guid">00000000-0000-0000-0000-000000000000</Single>
	<Single Name="ConnectedSinkHostGuid" Type="System.Guid">00000000-0000-0000-0000-000000000000</Single>
	<Single Name="ConnectedSrcConnMarkId" Type="long">-1</Single>
	<Single Name="RoutedConnMarkGlobalVariableName" Type="string"></Single>
	<Single Name="RoutedConnMarkGlobalVariableType" Type="string"></Single>
	<Single Name="OwningPageId" Type="long">-1</Single>
	<Single Name="Id" Type="long">3120</Single>
</Single>'''



from xml.etree.ElementTree import Element, SubElement, tostring

class connMarkSource:
  rootType = "{9e94943e-4951-4da7-a4e2-1f1bb71a6228}"

  def __init__(self, idGenerator:callable):
    self.id = 0
    self.idGenerator:callable = idGenerator

  @property
  def ID(self) -> int:
    if self.id == 0:
      self.id = self.idGenerator()

    return self.id

  def fromXml(self, element: Element):
    self.id = self.idGenerator(int(element.find(f"./*[@Name='Output']").find(f"./*[@Name='Id']").text))

    self.varName = element.find(f"./*[@Name='Text']").find(f"./*[@Name='Text']").text
    bounds = element.find(f"./*[@Name='Bounds']").text.split(', ')
    self.xPos = int(bounds[0])
    self.yPos = int(bounds[1])

    return self
  
  def fromInputs(self, varName: str, xPos: int, yPos: int):
    self.varName = varName
    self.xPos = xPos
    self.yPos = yPos

    return self
  

  def toXml(self) -> Element:
    element = Element('Single', Type=connMarkSource.rootType, Method="IArchivable")
    inputElem = SubElement(element, 'Single', Name="Output", Type="{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}", Method="IArchivable")
    SubElement(inputElem, 'Single', Name='Id', Type="long").text = str(self.ID)

    textElem = SubElement(element, 'Single', Name="Text", Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(textElem, 'Single', Name = 'Text', Type="string").text = self.varName
    
    SubElement(element, 'Single', Name = 'Bounds', Type="string").text = f"{self.xPos}, {self.yPos}, 0, 0"

    return element

  def toString(self) -> str:
    element = self.toXml()
    return tostring(element, encoding='unicode', method='xml')