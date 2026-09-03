from typing import List

from pathlib import Path

from dacToSim.DataModel.Project.DAC.Connections.fileHandling import collectFiles

from dacToSim.DataModel.Common import FileData



STARTS_WITH = ['MAIN','MASTER']  # Add more prefixes as needed

#def getVisuFiles(folderPath):
#  """
#  Collects all visualization files from the specified folder path.
#  
#  :param folderPath: Path to the folder containing visualization files.
#  :return: List of paths to visualization files.
#  """
#  visuFiles = collectFiles(['System'],['Project Info.xml'],"Visualization")
#  visuFiles.Search(folderPath)
#
#
#  return [file.name for file in visuFiles.files 
#    if any(file.name.upper().startswith(prefix) for prefix in STARTS_WITH)]


def getVisuFiles(folderPaths: List[Path]|Path) -> List[FileData]:
    """
    Collects all visualization files from a list of folder paths.
    
    :param folderPaths: List of paths to folders containing visualization files.
    :return: List of paths to visualization files.
    """
    if isinstance(folderPaths, Path):
      folderPaths = [folderPaths]

    allVisuFiles = []

    for path in folderPaths:
      if not path.is_dir():
        continue
      
      visuFiles = collectFiles(['System'],['Project Info.xml'],"Visualization")
      visuFiles.Search(path)

      filteredFiles = [file for file in visuFiles.files 
         if not any(file.name.upper().startswith(prefix) for prefix in STARTS_WITH)]
            
      allVisuFiles.extend(filteredFiles)
     
    return allVisuFiles