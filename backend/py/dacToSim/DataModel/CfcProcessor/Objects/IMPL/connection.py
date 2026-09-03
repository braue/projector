base='''<Single Type="{{5ae2e111-ecff-4a21-b647-2d4da63f8db7}}" Method="IArchivable">
  <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="SourcePinId" Type="long">{outputPinID}</Single>
  <Single Name="DestPinId" Type="long">{inputPinID}</Single>
  <Single Name="Id" Type="long">{lineID}</Single>
</Single>'''

from xml.etree.ElementTree import Element, SubElement, tostring

class Connection:
  rootType = "{5ae2e111-ecff-4a21-b647-2d4da63f8db7}"

  def __init__(self, idGenerator : callable):
      self.id = 0
      self.idGenerator : callable = idGenerator

  @property
  def ID(self) -> int:
    if self.id == 0:
      self.id = self.idGenerator()

    return self.id

  def fromXml(self, element: Element):
      self.sourcePinID = int(element.find(f"./*[@Name='SourcePinId']").text)
      self.destPinID = int(element.find(f"./*[@Name='DestPinId']").text)
      
      return self

  def fromInputs(self, sourcePinID: int, destPinID: int):
      self.sourcePinID = sourcePinID
      self.destPinID = destPinID

      return self


  def toXml(self) -> Element:
      element = Element('Single', Type= Connection.rootType, Method="IArchivable")
      SubElement(element, 'Single', Name='SourcePinId', Type="long").text = str(self.sourcePinID)
      SubElement(element, 'Single', Name='DestPinId', Type="long").text = str(self.destPinID)
      return element
  
  def toString(self) -> str:
      element = self.toXml()
      return tostring(element, encoding='unicode', method='xml')