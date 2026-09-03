base='''<Single Type="{{d51129f5-df27-4886-99d1-c564d2e2c1f6}}" Method="IArchivable">
  <Single Name="Output" Type="{{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}}" Method="IArchivable">
    <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
    <Null Name="ElementGroupId" />
    <Single Name="Negated" Type="bool">False</Single>
    <Single Name="SetReset" Type="{{24449d48-c96a-49c4-b9d1-a4ea34aedce3}}">None</Single>
    <Single Name="SetResetRef" Type="{{233bc97c-69fe-4d29-b40e-a9a9b854044e}}">None</Single>
    <Single Name="PretendsToBeConnected" Type="bool">False</Single>
    <Single Name="Id" Type="long">{outputID}</Single>
  </Single>
  <Single Name="Text" Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
    <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
    <Null Name="ElementGroupId" />
    <Single Name="Text" Type="string">{varName}</Single>
    <Single Name="Modifiable" Type="bool">True</Single>
    <Single Name="Id" Type="long">{textID}</Single>
  </Single>
  <Single Name="PageArea" Type="int">3</Single>
  <Single Name="Bounds" Type="string">{xPos}, {yPos}, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="OwningPageId" Type="long">-1</Single>
  <Single Name="Id" Type="long">{resID}</Single>
</Single>'''



from xml.etree.ElementTree import Element, SubElement, tostring

class CFC_SOURCE: # CFC_INPUT
  rootType = "{d51129f5-df27-4886-99d1-c564d2e2c1f6}"

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
    element = Element('Single', Type=CFC_SOURCE.rootType, Method="IArchivable")
    inputElem = SubElement(element, 'Single', Name="Output", Type="{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}", Method="IArchivable")
    SubElement(inputElem, 'Single', Name='Id', Type="long").text = str(self.ID)

    textElem = SubElement(element, 'Single', Name="Text", Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(textElem, 'Single', Name = 'Text', Type="string").text = self.varName
    
    SubElement(element, 'Single', Name = 'Bounds', Type="string").text = f"{self.xPos}, {self.yPos}, 0, 0"

    return element

  def toString(self) -> str:
    element = self.toXml()
    return tostring(element, encoding='unicode', method='xml')