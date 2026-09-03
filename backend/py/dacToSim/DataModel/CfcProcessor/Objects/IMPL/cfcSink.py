base='''<Single Type="{{8d9e2b78-3efe-4fe4-8160-f3a7381ddd8f}}" Method="IArchivable">
  <Single Name="Input" Type="{{5c3476a8-05c5-430e-861c-9cfa51d68ca8}}" Method="IArchivable">
    <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
    <Null Name="ElementGroupId" />
    <Single Name="ProcessValue" Type="string"></Single>
    <Single Name="Access" Type="{{88453c7d-d652-4a27-a1b0-a1953be49a5c}}">None</Single>
    <Single Name="Negated" Type="bool">False</Single>
    <Single Name="SetReset" Type="{{24449d48-c96a-49c4-b9d1-a4ea34aedce3}}">None</Single>
    <Single Name="SetResetRef" Type="{{233bc97c-69fe-4d29-b40e-a9a9b854044e}}">None</Single>
    <Single Name="PretendsToBeConnected" Type="bool">False</Single>
    <Single Name="Id" Type="long">{inputId}</Single>
  </Single>
  <Single Name="Text" Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
    <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
    <Null Name="ElementGroupId" />
    <Single Name="Text" Type="string">{varName}</Single>
    <Single Name="Modifiable" Type="bool">True</Single>
    <Single Name="Id" Type="long">{textId}</Single>
  </Single>
  <Single Name="PageArea" Type="int">4</Single>
  <Single Name="Bounds" Type="string">{xPos}, {yPos}, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="OwningPageId" Type="long">-1</Single>
  <Single Name="Id" Type="long">{resId}</Single>
</Single>'''


from xml.etree.ElementTree import Element, SubElement, tostring

# Named Output as these correspond to the output pins in the CFC
class CFC_SINK:  # CFC_SINK
  rootType = "{8d9e2b78-3efe-4fe4-8160-f3a7381ddd8f}"
  
  def __init__(self, idGenerator:callable):
    self.id = 0
    self.idGenerator:callable = idGenerator

  @property
  def ID(self) -> int:
    if self.id == 0:
      self.id = self.idGenerator()

    return self.id

  def fromXml(self, element: Element):
    self.id = self.idGenerator(int(element.find(f"./*[@Name='Input']").find(f"./*[@Name='Id']").text))
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

    element = Element('Single', Type=CFC_SINK.rootType, Method="IArchivable")
    outputElem = SubElement(element, 'Single', Name="Input", Type="{5c3476a8-05c5-430e-861c-9cfa51d68ca8}", Method="IArchivable")
    SubElement(outputElem, 'Single', Name='Id', Type="long").text = str(self.ID)

    textElem = SubElement(element, 'Single', Name="Text", Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(textElem, 'Single', Name='Text', Type="string").text = self.varName  

    SubElement(element, 'Single', Name='Bounds', Type="string").text = f"{self.xPos}, {self.yPos}, 0, 0"
    
    return element

  def toString(self) -> str:
    element = self.toXml()
    return tostring(element, encoding='unicode', method='xml')