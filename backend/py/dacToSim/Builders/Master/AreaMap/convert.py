
from pathlib import Path
from typing import List, Tuple, Dict

from dacToSim.constants import regEx

from dacToSim.DataModel.Device.Declaration import DeviceDeclaration
from dacToSim.DataModel.Project.Declarations import DeviceDeclarations

from dacToSim.DataModel.Profile import nameConversion

from .helpers import updateVarName, getNamesToUpdate

from .updateDeclarations import getExistingDeclaration, DeclarationGroup, Declaration

from dacToSim.DataModel.CfcProcessor import CfcFile, CFC_SOURCE, Connection

import re

RE_POU_KIND = re.compile(r'<POUKind>\w+</POUKind>', flags=regEx.defaultFlags)
RE_POU_NAME = re.compile(r'<Name>\w+</Name>', flags=regEx.defaultFlags)
RE_LINE_LOCK = re.compile(r'<Single Name="Locked" Type="bool">True</Single>', flags=regEx.defaultFlags)
RE_POU_DECL = re.compile(r'<Single Name="TextBlobForSerialisation" Type="string">.*(?:\n.*?)*?<\/Single>', flags=regEx.defaultFlags)

FEEDER_TYPES = {'DA_FDR', 'SIM_FDR'}


NEW_DECL = '''<Single Name="TextBlobForSerialisation" Type="string">FUNCTION_BLOCK {schemeName}_AreaMap
{body}</Single>'''


def updateFdrCalls(cfc:CfcFile):
  minXpos = int(1e6)
  for call in cfc.getCallsOfType("FDR"):
    if "AIBO" not in call.callName.upper():
      call.callName = f"{call.callName.split('.')[0]}.AiBo"

      newInput = CFC_SOURCE(cfc.idGenerator).fromInputs(f"{call.name}_A", call.xPos - 8, call.yPos + 2)
      newConnection = Connection(cfc.idGenerator).fromInputs(newInput.ID, call.addInputPin("A"))

      minXpos = min(minXpos, newInput.xPos)
      
      cfc.sources.append(newInput)    
      cfc.connections.append(newConnection)
  
  if minXpos < 0:
    cfc.offsetElements(xOffset= -minXpos + 1)


def convertAreaMap(dacPath:Path, schemeName:str, devDecs:List[DeviceDeclarations], nameConversions : List[nameConversion], targetPath : Path = '') -> str:
  deviceList : List[DeviceDeclaration]= []
  for devDec in devDecs:
    deviceList.extend(devDec.declarations)

  namesToUpdate = getNamesToUpdate(deviceList)

  # Read the DAC AreaMap file and perform updates
  newAreaMapCfc = CfcFile('FunctionBlock').fromFile(dacPath)

  # Update the POUKind and Name in the AreaMap
  updateFdrCalls(newAreaMapCfc)

  newAreaMap = newAreaMapCfc.toString()

  newAreaMap = RE_POU_KIND.sub('<POUKind>FunctionBlock</POUKind>', newAreaMap)
  newAreaMap = RE_POU_NAME.sub(f'<Name>{schemeName}_AreaMap</Name>', newAreaMap)
  newAreaMap = RE_LINE_LOCK.sub('<Single Name="Locked" Type="bool">False</Single>', newAreaMap)

  newAreaMap = newAreaMap.replace('>DA_FDR.Bo','>DA_FDR.AiBo')
  newAreaMap = newAreaMap.replace('>DA_','>SIM_')

  for conversion in nameConversions:
    oldName = conversion.old
    newName = conversion.new
    if not oldName or not newName:
      continue
    newAreaMap = re.sub(f'>{oldName}<', f'>{newName}<', newAreaMap, flags=regEx.defaultFlags)

  for oldName in namesToUpdate:
    newAreaMap = re.sub(f'>{oldName}<',f'>{updateVarName(oldName,schemeName)}<', newAreaMap, flags=regEx.defaultFlags)

  schemeFeeders = [i.name for i in deviceList if i.type.upper() in FEEDER_TYPES]

  schemeFeeders.sort()

  feederSrcs :List[Declaration]= []
  for fdr in schemeFeeders:
    feederSrcs.append(Declaration.fromDeclText(f"\t{fdr}_A : REFERENCE TO typeEquipmentLink := ;")            )
  
  # Create new declarations for the area map
  workingDecls = {
    'LOCAL': DeclarationGroup('LOCAL', feederSrcs),
    'INPUT': DeclarationGroup('INPUT', [])
  }

  # If targetPath is provided, read existing declarations from the target file
  # and merge them with the working declarations
  mergeAreaMapDeclarationGroups(targetPath, workingDecls)

  # Merge incoming declarations with the working declarations
  # This will add any new declarations from the incoming declarations
  # and update existing ones
  # Values from the incoming DAC has precedence over the existing ones
  mergeAreaMapDeclarationGroups(dacPath, workingDecls)

  existingSources = set([dec.name.upper() for dec in workingDecls['INPUT'].declarations])
  unconfiguredFeeders = [dec for dec in workingDecls['LOCAL'].declarations if not dec.value and dec.type.upper() in FEEDER_TYPES]

  if unconfiguredFeeders:
    print(f"Unconfigured feeders in {schemeName} AreaMap:")
    for fdr in unconfiguredFeeders:
      if False and fdr.name in TEST_VALUES:
        newSrc= TEST_VALUES[fdr.name]
      else:
        newSrc = input(f"  Please provide a source for {fdr.name}:").strip().replace(" ", "_")

      # Only update if a value is provided  
      if newSrc:
        fdr.value = f"{newSrc}_B"

        if fdr.value.upper() not in existingSources:
          workingDecls['INPUT'].appendInput(name=fdr.value, type="typeEquipmentLink")
          existingSources.add(fdr.value.upper())


  if not (targetPath and targetPath.exists()):
    workingDecls['LOCAL'].setNotes([
      "{warning 'Update to the appropriate source input and place inputs into AreaMap'}",
	    "// fdrName_A : REFERENCE TO typeEquipmentLink := scrName_B;]"
    ])

    workingDecls['INPUT'].setNotes([
      "{warning 'Insert substation sources here. Pattern is as follows'}",
	    "// srcName_B : typeEquipmentLink;"
    ])

  declOrder = ['IN_OUT', 'LOCAL', 'INPUT', 'OUTPUT']
  declFullDecl = {'LOCAL'}
  
  newDecl = NEW_DECL.format(
    schemeName=schemeName,
    body='\n'.join([workingDecls[decl].write(decl in declFullDecl) for decl in declOrder if decl in workingDecls and workingDecls[decl].declarations])
  )

  return RE_POU_DECL.sub(newDecl, newAreaMap)

def mergeAreaMapDeclarationGroups(areaMapPath:Path, workingDecls:Dict[str,DeclarationGroup]):
  if areaMapPath and areaMapPath.exists():
    decls = getExistingDeclaration(areaMapPath.read_text())
        
    for decl in decls:
      if decl.name.upper() in workingDecls:
        workingDecls[decl.name.upper()].merge(decl)
      else:
        workingDecls[decl.name.upper()] = decl


TEST_VALUES = {
	"F1857_A" : "F18",
	"F5383_A" : "F53",
	"F5805_A" : "F58",
	"F5850_A" : "F58",
	"F5870_A" : "F58",
	"F5890_A" : "F58",
	"F6310_A" : "F63",
	"F6350_A" : "F63",
	"F6429_A" : "F64",
	"F6510_A" : "F65",
	"F6544_A" : "F65",
	"F6546_A" : "F65",
	"F6550_A" : "F65",
	"F6580_A" : "F65",
	"F3183_A" : "F31",
	"F3431_A" : "F34",
	"F3434_A" : "F34",
	"F6830_A" : "F68",
	"F6832_A" : "F68",
	"F6878_A" : "F68",
	"F6879_A" : "F68",
	"F5001_A" : "F50",
	"F5071_A" : "F50",
	"F5087_A" : "F50",
	"F5100_A" : "F51",
	"F5202_A" : "F52",
	"F5203_A" : "F52",
	"F5240_A" : "F52",
	"F5241_A" : "F52",
	"F5242_A" : "F52",
	"F5257_A" : "F52",
	"F5310_A" : "F53",
	"FN2358_A" : "FN2",
	"F1178_A" : "F11",
	"F2533_A" : "F25",
	"F2534_A" : "F25",
	"F2535_A" : "F25",
	"F5402_A" : "F54",
	"F5430_A" : "F54",
	"F5451_A" : "F54",
	"F5466_A" : "F54",
	"F5525_A" : "F55",
	"F5550_A" : "F55",
	"F5579_A" : "F55",
	"F5602_A" : "F56",
	"F5603_A" : "F56",
	"F5625_A" : "F56",
	"F5673_A" : "F56",
	"F5674_A" : "F56",
	"F5675_A" : "F56",
	"F5676_A" : "F56",
	"F5711_A" : "F57",
	"F5712_A" : "F57",
	"F5713_A" : "F57",
	"F5716_A" : "F57",
	"F5760_A" : "F57",
	"F5761_A" : "F57",
	"F5762_A" : "F57",
	"F6428_A" : "F64",
	"F2666_A" : "F26",
	"F6000_A" : "F60",
	"F6001_A" : "F60",
	"F6004_A" : "F60",
	"F6005_A" : "F60",
	"F6106_A" : "F61",
	"F6107_A" : "F61",
	"F6165_A" : "F61",
	"F6166_A" : "F61",
	"F6167_A" : "F61",
	"F6203_A" : "F62"
}