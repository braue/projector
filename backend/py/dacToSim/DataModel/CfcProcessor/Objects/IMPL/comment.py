base='''
<Single Type="{{3487d131-7fd4-48ac-9e99-9e275c3b8ff8}}" Method="IArchivable">
  <Single Name="Text" Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
    <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
    <Null Name="ElementGroupId" />
    <Single Name="Text" Type="string">{msg}</Single>
    <Single Name="Modifiable" Type="bool">True</Single>
    <Single Name="Id" Type="long">{textID}</Single>
  </Single>
  <Single Name="PageArea" Type="int">0</Single>
  <Single Name="Bounds" Type="string">{xPos}, {yPos}, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="OwningPageId" Type="long">-1</Single>
  <Single Name="Id" Type="long">{resID}</Single>
</Single>'''

from xml.etree.ElementTree import Element, SubElement, tostring

class Comment:
  rootType = "{3487d131-7fd4-48ac-9e99-9e275c3b8ff8}"

  def __init__(self, idGenerator:callable):
    self.id = 0
    self.idGenerator:callable = idGenerator

  @property
  def ID(self) -> int:
    if self.id == 0:
      self.id = self.idGenerator()

    return self.id

  def fromXml(self, element: Element):
    self.msg = element.find(f"./*[@Name='Text']").find(f"./*[@Name='Text']").text
    bounds = element.find(f"./*[@Name='Bounds']").text.split(', ')
    self.xPos = int(bounds[0])
    self.yPos = int(bounds[1])

    return self
  
  def fromInputs(self, msg: str, xPos: int, yPos: int):
    self.msg = msg
    self.xPos = xPos
    self.yPos = yPos

    return self
  

  def toXml(self) -> Element:    
    element = Element('Single', Type= Comment.rootType, Method="IArchivable")
    text = SubElement(element, 'Single', Name='Text', Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(text, 'Single', Name='Text', Type='string').text = self.msg

    SubElement(element, 'Single', Name='Bounds', Type="string").text = f"{self.xPos}, {self.yPos}, 0, 0"
    return element
  
  def toString(self) -> str:
    element = self.toXml()
    return tostring(element, encoding='unicode', method='xml')