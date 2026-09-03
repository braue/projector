inst='''<Single Type="{{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}}" Method="IArchivable">
  <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="Negated" Type="bool">False</Single>
  <Single Name="SetReset" Type="{{24449d48-c96a-49c4-b9d1-a4ea34aedce3}}">None</Single>
  <Single Name="SetResetRef" Type="{{233bc97c-69fe-4d29-b40e-a9a9b854044e}}">None</Single>
  <Single Name="PretendsToBeConnected" Type="bool">False</Single>
  <Single Name="Id" Type="long">{outputPinID[0]}</Single>
</Single>'''

label='''<Single Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}" Method="IArchivable">
  <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="Text" Type="string">DA_FDR.Bo</Single>
  <Single Name="Modifiable" Type="bool">True</Single>
  <Single Name="Id" Type="long">419</Single>
</Single>'''


from typing import List
from xml.etree.ElementTree import Element, SubElement, tostring


  
class POU_OUTPUT_PIN:
  rootType = "{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}"

  def __init__(self, idGenerator:callable):
    self.id = 0
    self.idGenerator:callable = idGenerator
    self.name = ""

  @property
  def ID(self) -> int:
    if self.id == 0:
      self.id = self.idGenerator()

    return self.id

  def fromXml(self, instEle: Element, labelEle: Element):
    self.id = self.idGenerator(int(instEle.find(f"./*[@Name='Id']").text))
    self.name = labelEle.find(f"./*[@Name='Text']").text

    return self
  
  def fromInputs(self, name: str) -> 'POU_OUTPUT_PIN':
    self.name = name

    return self
  
  def toXmlInst(self) -> Element:
    element = Element('Single', Type= POU_OUTPUT_PIN.rootType, Method="IArchivable")
    SubElement(element, 'Single', Name='Id', Type="long").text = str(self.ID)

    return element
  
  def toStringInst(self) -> str:
    element = self.toXmlInst()
    return tostring(element, encoding='unicode', method='xml')
  
  def toXmlLabel(self) -> Element:
    element = Element('Single', Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(element, 'Single', Name='Text', Type="string").text = self.name

    return element
  
  def toStringLabel(self) -> str:
    element = self.toXmlLabel()
    return tostring(element, encoding='unicode', method='xml')
