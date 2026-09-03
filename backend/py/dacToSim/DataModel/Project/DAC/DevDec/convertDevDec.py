import re
from pathlib import Path


from dacToSim.constants.names import folders, fileNames
from dacToSim.constants.regEx import defaultFlags

from dacToSim.common import writeFile
from dacToSim.constants.schemas import settings
from dacToSim.constants.names.dacNames import DEVICE_DECLARATION

from typing import List,Dict
from dacToSim.DataModel.Project import DeviceDeclarations, MASTER_UNIQUE_NAME_TYPES

from dacToSim.DataModel.Profile import Scheme

from .getDacDevDict import getDacDevDict
from .helpers import updateVarName, splitDeclaration

def convertDevDecMaster(contents : str, nameConversions : list, schemeName : str):
  print("convertDevDecMaster: Actually doing things")
  input()
  ''' 
    contents - original file body
    nameConversions - find and replace pattern for any update pou names
    schemeName - name of DAC scheme
  '''

  newContentsLine =  contents.split('\n')
  for bodyIndex, line in enumerate(newContentsLine):
    varNames = []
    varType = ''
    if any(x in line.upper() for x in MASTER_UNIQUE_NAME_TYPES):
      varNames, varType = splitDeclaration(line)
      
      for varIndex, varName in enumerate(varNames):
        varNames[varIndex] = updateVarName(varName, schemeName)

      newContentsLine[bodyIndex] = '\t' + ', '.join(varNames) + f' : {varType};'
  
  newContents = '\n'.join(newContentsLine)

  for nameConversion in nameConversions:
    newContents = newContents.replace(nameConversion[settings.OLD],nameConversion[settings.NEW])

  newContents = re.sub(r'<Name>\w+</Name>',f'<Name>{schemeName}_DevDec</Name>',newContents, flags=defaultFlags)
  newContents = re.sub(r':(?:\s*?)DA_', ': SIM_', newContents, flags=defaultFlags)
  newContents = re.sub(r'.*?ScreenNum.*', '', newContents, flags=defaultFlags)
  newContents = re.sub(r'\n\s*\n\s*\n', '\n\n', newContents, flags=defaultFlags)

  return newContents

def convertDevDecRemoteIo(contents : str, nameConversions : list, schemeName : str):
  ''' 
    contents - original file body
    nameConversions - find and replace pattern for any update pou names
    schemeName - name of DAC scheme
  '''
  
  newContents = contents

  newContents = re.sub(r'<Name>\w+</Name>',f'<Name>{schemeName}_DevDec</Name>',newContents, flags=defaultFlags)
  newContents = re.sub(r':(?:\s*?)DA_(\w+)', r': SIM_\1_REMOTE', newContents, flags=defaultFlags)
  newContents = re.sub(r'.*?ScreenNum.*', '', newContents, flags=defaultFlags)
  newContents = re.sub(r'\n\s*\n\s*\n', '\n\n', newContents, flags=defaultFlags)

  return newContents

from .templates import devDecTemplate

def createDevDecSource(schemeName):
  

  return devDecTemplate.format(
    pouName=f'{schemeName}_Sources',
    body=''
  )

def getDacDevDec(folderPath, profile : Scheme)-> List[DeviceDeclarations]:
    # Process DevDec
    dacDevDecPath = folderPath / f"{DEVICE_DECLARATION}.xml"
  
    return [DeviceDeclarations().fromPath(dacDevDecPath)]

if __name__ == "__main__":
  from . import testCases

  newBody = convertDevDecMaster(contents=testCases.devDec, nameConversions=testCases.nameConversions,  schemeName='Mansfield')

  from pathlib import Path
  destPath = Path(__file__).parents[0] / 'testCases' / 'results.xml'
  writeFile(destPath, newBody)
