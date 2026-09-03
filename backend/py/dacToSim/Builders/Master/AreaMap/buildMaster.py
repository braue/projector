
from typing import List, Dict
from pathlib import Path


from dacToSim.DataModel.CfcProcessor import CfcFile
from dacToSim.DataModel.CfcProcessor.Objects import CFC_SINK, CFC_SOURCE, POU_CALL, Connection


from .updateDeclarations import Declaration, DeclarationGroup, getExistingDeclaration

SOURCE_COLUMN_XPOS : int = 2
TRANSFORMER_COLUMN_XPOS : int = 2
AREA_MAP_COLUMN_XPOS : int = 32




class schemeArea():
  def __init__(self, name: str, inputs: DeclarationGroup, outputs: DeclarationGroup):
    self.name = name
    self.inputs : DeclarationGroup = inputs
    self.outputs : DeclarationGroup = outputs

  def getInputNames(self) -> List[str]:
    if self.inputs is None:
      return []
    return [decl.name for decl in self.inputs.declarations]
  
  def getOutputNames(self) -> List[str]:
    if self.outputs is None:
      return []
    return [decl.name for decl in self.outputs.declarations]


def buildMasterAreaMap(existingPath: Path, cfcAreaMaps:Dict[str,CfcFile], newAreaSources:Dict[str,List[str]]) -> str:
  # Parse the existing area map input CfcFile
  # and build a new area map with the given area maps
  # any existing inputs and outputs will be preserved
  # and the new area maps will be added to the end

  areaMaps : List[schemeArea] = []
  for name, cfc in cfcAreaMaps.items():
    inputs = next((decl for decl in cfc.declarations if decl.name.upper() == 'INPUT'), None)
    outputs = next((decl for decl in cfc.declarations if decl.name.upper() == 'OUTPUT'), None)
    areaMaps.append(schemeArea(name, inputs, outputs))


  if existingPath.exists():
    cfcFile = CfcFile('Program').fromFile(existingPath)
  else:
    cfcFile = CfcFile('Program')
    cfcFile.pou_name = 'AreaMap'

  localDecl = next((decl for decl in cfcFile.declarations if decl.name.upper() == 'LOCAL'), None)
  if localDecl is None:
    localDecl = DeclarationGroup('LOCAL', [])
    cfcFile.declarations.append(localDecl)


  # get all area map calls
  existingAreaMapCalls = [call for call in cfcFile.pouCalls if "AREAMAP" in call.callName.upper()]
  existingTransformerCalls = [call for call in cfcFile.pouCalls if "TRANSFORMER" in call.callName.upper()]

  for areaMap in areaMaps:
    # Find existing POU_CALL with the same name
    workingCall = next((call for call in cfcFile.pouCalls if call.name.upper() == areaMap.name.upper()), None)
    if workingCall is None:
      
      # Create a new POU_CALL for the area map
      newCall = POU_CALL(cfcFile.idGenerator)
      newCall.fromInputs(
        inputPins=[],
        outputPins=[],
        xPos=AREA_MAP_COLUMN_XPOS,
        yPos=1 + max(len(existingAreaMapCalls) * 25, len(existingTransformerCalls) * 4) ,
        name=areaMap.name,
        callName=f'{areaMap.name}_AreaMap'
      )
      cfcFile.pouCalls.append(newCall)
      workingCall = newCall
      existingAreaMapCalls.append(workingCall)
      localDecl.appendInput(name=areaMap.name, type=f'{areaMap.name}_AreaMap')

    # Add inputs to the existing call
    newInputs = workingCall.appendInputPins(areaMap.getInputNames())

    newAreaSources[areaMap.name.replace("_AreaMap","")] = []

    # Create new call for new inputs
    for i, inputPin in enumerate(newInputs):
      sourceName = inputPin.name
      if inputPin.name.endswith("_B"):
        sourceName = sourceName[:-2]

      newAreaSources[areaMap.name].append(sourceName)
      newSourceCall = POU_CALL(cfcFile.idGenerator)
      newSourceCall.fromInputs(
        inputPins=[],
        outputPins=[],
        xPos=TRANSFORMER_COLUMN_XPOS,
        yPos=workingCall.yPos + i * 4,
        name=sourceName,
        callName=f'SIM_SUB_TRANSFORMER.Bo'
      )
      newSourceCall.appendOutputPins(['B'])

      cfcFile.pouCalls.append(newSourceCall)
      existingTransformerCalls.append(newSourceCall)

      # Create a connection from the new source call to the area map call
      newConnection = Connection(cfcFile.idGenerator)
      newConnection.fromInputs(
        sourcePinID=newSourceCall.outputPins[0].ID,
        destPinID=inputPin.ID
      )
      cfcFile.connections.append(newConnection)

  arrangeAreaMap(cfcFile)

  return cfcFile.toString()




def arrangeAreaMap(cfcFile: CfcFile):
  transformerVerticalSpacing = 4
  areaMapVerticalMinSpacing = 2

  # Arrange the area map by having a column of SIM_SUB_TRANSFORMER calls on the left arranged vertically
  # and the area map calls on the right arranged vertically
  # The SIM_SUB_TRANSFORMER are to be arranged in the order of first use from the area maps
  # The area maps are to be arranged in the order they were added
  # Vertical spacing between SIM_SUB_TRANSFORMER is to be 3 with the area map roughly centered with the height approximation of 2 + max(len(inputs), len(outputs)) * 0.5

  yOffset = 0
  transformerCalls = [call for call in cfcFile.pouCalls if "TRANSFORMER" in call.callName.upper()]
  areaMapCalls = [call for call in cfcFile.pouCalls if "AREAMAP" in call.callName.upper()]

  if not transformerCalls or not areaMapCalls:
    return cfcFile
  
  # Group transformer calls by connected area map calls
  transformerGroups : Dict[POU_CALL,List[POU_CALL]] = {}
  assignedTransformerCalls = set()

  transformersByPinID = {pin.ID: call for call in transformerCalls for pin in call.outputPins}
  areaMapsByPinID = {pin.ID: call for call in areaMapCalls for pin in call.inputPins}

  for connection in cfcFile.connections:
    transformerCall = transformersByPinID.get(connection.sourcePinID)
    areaMapCall = areaMapsByPinID.get(connection.destPinID)

    if transformerCall and areaMapCall:
      if areaMapCall not in transformerGroups:
        transformerGroups[areaMapCall] = []
      transformerGroups[areaMapCall].append(transformerCall)
      assignedTransformerCalls.add(areaMapCall)

  # Arrange transformer calls in a column
  for areaMapCall, transformerGroup in transformerGroups.items():
    if not transformerGroup:
      print(f"No transformer calls for area map {areaMapCall.name}")
      continue

    # Arrange the transformer calls vertically
    for i, transformerCall in enumerate(transformerGroup):
      transformerCall.xPos = TRANSFORMER_COLUMN_XPOS
      transformerCall.yPos = yOffset + i * transformerVerticalSpacing  # Vertical spacing of 4
    
    
    next_yOffset = len(transformerGroup)  * transformerVerticalSpacing

    # Arrange the area map call to the right of the transformer calls
    areaMapCall.xPos = AREA_MAP_COLUMN_XPOS  # Right of the transformer calls
    areaMapCall.yPos = int(yOffset + int(( next_yOffset - 2 - len(areaMapCall.inputPins)) / 2))  # Centered vertically
  
    yOffset += next_yOffset + transformerVerticalSpacing