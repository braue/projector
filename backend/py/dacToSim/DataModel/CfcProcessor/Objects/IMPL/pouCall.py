base='''<Single Type="{{f5becf35-b1f3-4274-b411-81d4b63a1516}}" Method="IArchivable">
  <Single Name="Inputs" Type="{{cd57ba20-558b-4b98-96c1-73c6000c3087}}" Method="IArchivable">
    <List2 Name="InnerList">
      <Single Type="{{c994f6e0-311a-4a1c-bc38-75fe34892406}}" Method="IArchivable">
        <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
        <Null Name="ElementGroupId" />
        <Single Name="IsExtensiblePin" Type="bool">False</Single>
        <Single Name="ProcessValue" Type="string"></Single>
        <Single Name="Access" Type="{{88453c7d-d652-4a27-a1b0-a1953be49a5c}}">None</Single>
        <Single Name="Negated" Type="bool">False</Single>
        <Single Name="SetReset" Type="{{24449d48-c96a-49c4-b9d1-a4ea34aedce3}}">None</Single>
        <Single Name="SetResetRef" Type="{{233bc97c-69fe-4d29-b40e-a9a9b854044e}}">None</Single>
        <Single Name="PretendsToBeConnected" Type="bool">False</Single>
        <Single Name="Id" Type="long">{inputPinID[0]}</Single>
      </Single>
    </List2>
  </Single>
  <Single Name="Outputs" Type="{{cd57ba20-558b-4b98-96c1-73c6000c3087}}" Method="IArchivable">
    <List2 Name="InnerList">
      <Single Type="{{65582d84-cf18-4ca0-be59-bf5a3d00b8f8}}" Method="IArchivable">
        <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
        <Null Name="ElementGroupId" />
        <Single Name="Negated" Type="bool">False</Single>
        <Single Name="SetReset" Type="{{24449d48-c96a-49c4-b9d1-a4ea34aedce3}}">None</Single>
        <Single Name="SetResetRef" Type="{{233bc97c-69fe-4d29-b40e-a9a9b854044e}}">None</Single>
        <Single Name="PretendsToBeConnected" Type="bool">False</Single>
        <Single Name="Id" Type="long">{outputPinID[0]}</Single>
      </Single>
    </List2>
  </Single>
  <Single Name="Texts" Type="{{cd57ba20-558b-4b98-96c1-73c6000c3087}}" Method="IArchivable">
    <List2 Name="InnerList">
      <Single Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
        <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
        <Null Name="ElementGroupId" />
        <Single Name="Text" Type="string">A</Single>
        <Single Name="Modifiable" Type="bool">True</Single>
        <Single Name="Id" Type="long">{textID[0]}</Single>
      </Single>
      <Single Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
        <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
        <Null Name="ElementGroupId" />
        <Single Name="Text" Type="string">B</Single>
        <Single Name="Modifiable" Type="bool">True</Single>
        <Single Name="Id" Type="long">{textID[1]}</Single>
      </Single>
      <Single Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
        <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
        <Null Name="ElementGroupId" />
        <Single Name="Text" Type="string">SIM_REC.AiBo</Single>
        <Single Name="Modifiable" Type="bool">True</Single>
        <Single Name="Id" Type="long">{textID[2]}</Single>
      </Single>
      <Single Type="{{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}}" Method="IArchivable">
        <Single Name="Bounds" Type="string">0, 0, 0, 0</Single>
        <Null Name="ElementGroupId" />
        <Single Name="Text" Type="string">SIM_REC_NAME</Single>
        <Single Name="Modifiable" Type="bool">True</Single>
        <Single Name="Id" Type="long">{textID[3]}</Single>
      </Single>
    </List2>
  </Single>
  <Single Name="Parameters" Type="{{cd57ba20-558b-4b98-96c1-73c6000c3087}}" Method="IArchivable">
    <List2 Name="InnerList" />
  </Single>
  <Null Name="PreparedParameters" />
  <Single Name="PageArea" Type="int">0</Single>
  <Single Name="Bounds" Type="string">{xPos}, {yPos}, 0, 0</Single>
  <Null Name="ElementGroupId" />
  <Single Name="EnEno" Type="bool">False</Single>
  <Single Name="KindOfCall" Type="{{77f43dfe-ca6a-4869-828f-7609d8ed6ea6}}">Method</Single>
  <Single Name="ContainsExtensibleInputs" Type="bool">False</Single>
  <Single Name="Forced" Type="bool">False</Single>
  <Single Name="IsFeedbackStart" Type="bool">False</Single>
  <Single Name="OwningPageId" Type="long">-1</Single>
  <Single Name="Id" Type="long">{objID}</Single>
</Single>'''



from typing import List
from xml.etree.ElementTree import Element, SubElement, tostring
from .pou_input import POU_INPUT_PIN
from .pou_output import POU_OUTPUT_PIN

class POU_CALL:
  rootType = "{f5becf35-b1f3-4274-b411-81d4b63a1516}"

  def __init__(self, idGenerator:callable):
    self.id = 0
    self.idGenerator:callable = idGenerator

  @property
  def ID(self) -> int:
    if self.id == 0:
      self.id = self.idGenerator()

    return self.id

  def fromXml(self, element: Element):
    self.inputPins: List[POU_INPUT_PIN] = []
    self.outputPins: List[POU_OUTPUT_PIN] = []
    for inputElem in element.find(f"./*[@Name='Inputs']").find('List2').findall('Single'):
      pin = POU_INPUT_PIN(self.idGenerator)
      label = element.find(f"./*[@Name='Texts']").find('List2').findall('Single')[len(self.inputPins)]
      pin.fromXml(inputElem, label)
      self.inputPins.append(pin)
    for outputElem in element.find(f"./*[@Name='Outputs']").find('List2').findall('Single'):
      pin = POU_OUTPUT_PIN(self.idGenerator)
      label = element.find(f"./*[@Name='Texts']").find('List2').findall('Single')[len(self.outputPins) + len(self.inputPins)]
      pin.fromXml(outputElem, label)
      self.outputPins.append(pin)

    self.callName = element.find(f"./*[@Name='Texts']").find('List2').findall('Single')[len(self.inputPins) + len(self.outputPins)].find(f"./*[@Name='Text']").text
    self.name = element.find(f"./*[@Name='Texts']").find('List2').findall('Single')[len(self.inputPins) + len(self.outputPins) + 1].find(f"./*[@Name='Text']").text

    self.xPos = int(element.find(f"./*[@Name='Bounds']").text.split(', ')[0])
    self.yPos = int(element.find(f"./*[@Name='Bounds']").text.split(', ')[1])

    return self
  
  def fromInputs(self, inputPins : List[POU_INPUT_PIN], outputPins : List[POU_OUTPUT_PIN], xPos: int, yPos: int, name: str, callName: str) -> 'POU_CALL':
    self.inputPins = inputPins
    self.outputPins = outputPins
    self.xPos = xPos
    self.yPos = yPos
    self.name = name
    self.callName = callName

    return self
  
  def appendInputPins(self, pinNames: List[str]) -> List[POU_INPUT_PIN]:
    existingNames = [pin.name.upper() for pin in self.inputPins]
    newPins = []

    for name in pinNames:
      if name.upper() not in existingNames:
        newPins.append(POU_INPUT_PIN(self.idGenerator).fromInputs(name))
    self.inputPins.extend(newPins)

    return newPins
  
  def appendOutputPins(self, pinNames: List[str]) -> List[POU_OUTPUT_PIN]:
    existingNames = [pin.name.upper() for pin in self.outputPins]
    newPins = []

    for name in pinNames:
      if name.upper() not in existingNames:
        newPins.append(POU_OUTPUT_PIN(self.idGenerator).fromInputs(name))
    self.outputPins.extend(newPins)

    return newPins
  
  def _getInputInst(self) -> Element:
    element = Element('Single', Name='Inputs', Type="{cd57ba20-558b-4b98-96c1-73c6000c3087}", Method="IArchivable")
    innerList = SubElement(element, 'List2', Name="InnerList")
    for pin in self.inputPins:
      innerList.append(pin.toXmlInst())
    return element
  
  def _getOutputInst(self) -> Element:
    element = Element('Single', Name='Outputs', Type="{cd57ba20-558b-4b98-96c1-73c6000c3087}", Method="IArchivable")
    innerList = SubElement(element, 'List2', Name="InnerList")
    for pin in self.outputPins:
      innerList.append(pin.toXmlInst())
    return element
  
  def _getLabel(self) -> Element:
    element = Element('Single', Name='Texts', Type="{cd57ba20-558b-4b98-96c1-73c6000c3087}", Method="IArchivable")
    innerList = SubElement(element, 'List2', Name="InnerList")
    for pin in self.inputPins:
      innerList.append(pin.toXmlLabel())
    for pin in self.outputPins:
      innerList.append(pin.toXmlLabel())

    callNameElem = SubElement(innerList, 'Single', Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(callNameElem, 'Single', Name='Text', Type="string").text = self.callName

    nameElem = SubElement(innerList, 'Single', Type="{72f2b13f-5349-4a8a-bbe6-2bccf3f42179}", Method="IArchivable")
    SubElement(nameElem, 'Single', Name='Text', Type="string").text = self.name

    return element
  
  def toXml(self) -> Element:
    element = Element('Single', Type=POU_CALL.rootType, Method="IArchivable")
    
    element.append(self._getInputInst())
    element.append(self._getOutputInst())
    element.append(self._getLabel())

    SubElement(element, 'Single', Name='Parameters', Type="{cd57ba20-558b-4b98-96c1-73c6000c3087}", Method="IArchivable").append(
      Element('List2', Name='InnerList'))

    SubElement(element, 'Single', Name='Bounds', Type="string").text = f"{self.xPos}, {self.yPos}, 0, 0"


    # TODO: FUTURE: Handle better detection of call types. Hard to determine from the name alone for generic calls
    if '.' in self.callName:
      kindOfCall = "Method"
    else:
      kindOfCall = "FunctionBlock"

    SubElement(element, 'Single', Name='KindOfCall', Type="{77f43dfe-ca6a-4869-828f-7609d8ed6ea6}").text = kindOfCall

    return element
  
  def toString(self) -> str:
    element = self.toXml()
    return tostring(element, encoding='unicode', method='xml')
  
  def addInputPin(self, name:str) -> int:
    self.inputPins.append(POU_INPUT_PIN(self.idGenerator).fromInputs(name))

    return self.inputPins[-1].ID

  def addOutputPin(self, name:str) -> int:
    self.outputPins.append(POU_OUTPUT_PIN(self.idGenerator).fromInputs(name))

    return self.outputPins[-1].ID
  
  def inputIDs(self) -> List[int]:
    return [pin.ID for pin in self.inputPins]
  
  def outputIDs(self) -> List[int]:
    return [pin.ID for pin in self.outputPins]