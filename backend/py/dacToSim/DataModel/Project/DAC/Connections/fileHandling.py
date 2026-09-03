from pathlib import Path
from typing import List,Dict
import re

from dacToSim.DataModel.Common import FileData


def getFileType(filePath:Path|str, requirements):
  path = Path(filePath)
  contents = path.read_text()

  return requirements in contents


def getDirectories(dirPath:Path, folderBlacklist) -> List[Path]:
  '''getDirectories - Returns all filtered directories in the dirPath'''
  return [x for x in dirPath.iterdir() if x.is_dir() and str(x.stem).upper() not in folderBlacklist] 


def getFiles(dirPath:Path, fileBlacklist, typeRequirements) -> List[FileData]:
  '''getFiles - Returns all filtered files in the dirPath'''
  return [ FileData(x) for x in list(dirPath.glob('*.xml')) if x.is_file() and str(x.stem).upper() not in fileBlacklist and getFileType(x,typeRequirements)]

class collectFiles():
  def __init__(self, folderBlacklist, fileBlacklist, typeRequirements):
    self.files = []
    self.root = Path().cwd()

    self.fileBlacklist = fileBlacklist
    self.folderBlacklist = folderBlacklist
    self.typeRequirements = typeRequirements
  
  def _findFiles(self, dirPath) -> List[FileData]:
    ''' findFiles - Searches for all files in the given folderPath. '''
    files : List[FileData] = []
    # Look through the files in the directory for the file appropriate file names
    newFiles = getFiles(dirPath, self.fileBlacklist, self.typeRequirements)
    if newFiles:
      files.extend(sorted(newFiles))

    # Recursively go through the directories to find all the appropriate files
    directories = sorted(getDirectories(dirPath, self.folderBlacklist))
    for directory in directories:
        newFiles = self._findFiles(directory)
        if newFiles:
          files.extend(sorted(newFiles))
    return files
      
  def Search(self, rootPath : Path):     
    self.root = Path(rootPath)

    
    if (not self.root.is_dir()):
      print(f"Path is not a directory. Check spelling") 

    self.files = self._findFiles(self.root)

    for file in self.files:
      file.setRelPath(self.root)

    pouType = re.sub(r'</.*?>','',self.typeRequirements).replace("<","").replace(">"," ")
    if False:
      print(f"Type: {pouType} - {len(self.files)} found")
    return self.files

