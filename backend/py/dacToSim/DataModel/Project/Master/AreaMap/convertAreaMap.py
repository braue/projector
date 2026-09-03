import re
from pathlib import Path


from dacToSim.DataModel.Project.DAC.DevDec import getNamesToUpdate, updateVarName
from dacToSim.common import writeFile

from dacToSim.constants.names import folders, fileNames
from dacToSim.constants.regEx import defaultFlags
from dacToSim.constants.names.simMasterNames import SCHEME_AREAMAP, GLOBAL_AREAMAP
from dacToSim.constants.names.dacNames import AREAMAP as DAC_AREAMAP
from dacToSim.constants.schemas import settings
from dacToSim.DataModel.Profile import Scheme

from typing import List

RE_GET_VAR_GROUP = re.compile(r'VAR(?:_(?P<type>\w+)|)\s*(?P<modifier>\w+|)\n(?P<body>(?:.*?\n)*?)END_VAR')
RE_GET_VARS = re.compile(r'(?P<name>\w+)\s*:\s*(?P<type>[\w\s\[\]\.\(\)]+)(?:\s*:=\s*(?P<initialVal>[\w\s]+))?;')

from pprint import pprint

def _breakdownDecl(body):
  sections = []

  matches = RE_GET_VAR_GROUP.finditer(body)
  for match in matches:   
    newSection = {
      'type': match.group('type').strip() if match.groupdict().get("type") is not None else '',
      'modifier': match.group('modifier').strip(),
      'vars':[]
    }
  
    matchVars = RE_GET_VARS.finditer(match.group('body'))    
    for matchVar in matchVars:
      newSection['vars'].append(
        {
          'name': matchVar.group('name').strip(),
          'type': matchVar.group('type').strip(),
          'initVal': matchVar.group('initialVal').strip() if matchVar.groupdict().get("initialVal") is not None else ''
        }
      )
    sections.append(newSection)

  return sections

def _buildDeclSection(declGroup):
  type = declGroup['type']
  modifier = declGroup['modifier']
  groupVars = declGroup['vars']

  body = [
    f'VAR{f"_{type}" if type else ''}{f" {modifier}" if modifier else ''}',
    *[f'\t{var["name"]} : {var["type"]}{f' := {var['initVal']}' if var['initVal'] else ''};' for var in groupVars  ],
    "END_VAR"
  ]

  return '\n'.join(body)

DEFAULT_INPUT = '''VAR_INPUT
\t{{warning 'Insert substation sources here. Pattern is as follows'}}
\t// srcName_B : typeEquipmentLink;
END_VAR'''

DEFAULT_FDR_ASSIGN = '''VAR
\t{{warning 'Update to the appropriate source input and place inputs into AreaMap'}}
\t// fdrName_A : REFERENCE TO typeEquipmentLink := scrName_B;
{fdrRef}
END_VAR'''


def _convertAreaMap(contents : str, deviceList : dict, schemeName : str):
  print(f"Converting AreaMap for {schemeName} with {len(deviceList)} devices")
  namesToUpdate = getNamesToUpdate(deviceList)
  newAreaMap = contents

  newAreaMap = re.sub(r'<POUKind>\w+</POUKind>','<POUKind>FunctionBlock</POUKind>',newAreaMap, flags=defaultFlags)
  newAreaMap = re.sub(r'<Name>\w+</Name>',f'<Name>{schemeName}_AreaMap</Name>',newAreaMap, flags=defaultFlags)
  
  newAreaMap = re.sub(r'<Single Name="Locked" Type="bool">True</Single>','<Single Name="Locked" Type="bool">False</Single>', newAreaMap, flags=defaultFlags)

  newAreaMap = newAreaMap.replace('>DA_FDR.Bo','>DA_FDR.AiBo')
  newAreaMap = newAreaMap.replace('>DA_','>SIM_')

  for oldName in namesToUpdate:
    newAreaMap = re.sub(f'>{oldName}<',f'>{updateVarName(oldName,schemeName)}<', newAreaMap, flags=defaultFlags)

  regExDecl = r'<Single Name="TextBlobForSerialisation" Type="string">.*(?:\n.*?)*?<\/Single>'

  declGroupsStr = []

  declGroups = _breakdownDecl(contents)

  if declGroups[0]['type'].upper() == 'INPUT' and declGroups[0]['vars'][0]['type'].upper() == 'typeEquipmentLink'.upper():
    for declGroup in declGroups:
      declGroupsStr.append(_buildDeclSection(declGroup))
  else:
    declGroupsStr.append(DEFAULT_INPUT)
    schemeFeeders = [k for k, i in deviceList.items() if i['type'].upper() == 'DA_FDR']
    schemeFeeders.sort()
    
    if len(schemeFeeders) > 0:
      fdrRef = '\n'.join([f"\t{fdr.strip()}_A : REFERENCE TO typeEquipmentLink := ;" for fdr in schemeFeeders])
    else:
      fdrRef = ''
      
    declGroupsStr.append(DEFAULT_FDR_ASSIGN.format(fdrRef=fdrRef))

  newDecl = f'''<Single Name="TextBlobForSerialisation" Type="string">FUNCTION_BLOCK {schemeName}_AreaMap
{'\n'.join(declGroupsStr)}</Single>'''


  return re.sub(regExDecl,newDecl, newAreaMap, flags=defaultFlags)

def buildAreaMap(rootPath, profile : Scheme, deviceList):
  dacRootPath = rootPath / profile.dac.subFolder
  simMasterRootPath = rootPath / profile.logic.subFolder

  dacAreaMapPath = dacRootPath / folders.DEVICE / folders.DAC_LOGIC / f"{DAC_AREAMAP}.xml"
  dacAreaMap = dacAreaMapPath.read_text()

  mappedProfile = profile.toDict()

  masterAreaMapPath = simMasterRootPath / folders.DEVICE / folders.SIM_LOGIC / folders.SIM_SUBFOLDER_DYN.format(**mappedProfile) / folders.AREA_MAP / SCHEME_AREAMAP.format(**profile)
  writeFile(masterAreaMapPath,_convertAreaMap(dacAreaMap, deviceList, profile.schemeName))


def buildMasterAreaMap(rootPath : Path, profiles : List[Scheme]):
  from .templates import blankCfcTemplate
  declarations = []
  for profile in profiles:
    declarations.append(f"\t{profile.schemeName} : {SCHEME_AREAMAP.format(**profile)};")

  areaMapPath = rootPath / profile.logic.subFolder / folders.DEVICE / folders.SIM_LOGIC / f"{GLOBAL_AREAMAP}.xml"

  writeFile(areaMapPath, blankCfcTemplate.format(pouName=folders.AREA_MAP,declarations='\n'.join(declarations)), overwrite=False)


if __name__ == "__main__":
  from . import testCases

  newBody = _convertAreaMap(contents=testCases.areaMap, deviceList=testCases.deviceList, schemeName='TestMe')

  from pathlib import Path
  destPath = Path(__file__).parents[0] / 'testCases' / 'results.xml'
  if destPath.exists:
    destPath.unlink
  destPath.parents[0].mkdir(parents=True, exist_ok=True)
  destPath.open('w').write(newBody)
