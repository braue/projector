from typing import List, Dict


from pathlib import Path
from dacToSim.DataModel.Project import MasterProject
from dacToSim.common import writeFile
from .Template import BlankVisualization, EnumVisuTemplate
from .MainVisu import generateVisu as genMainVisu
from .SimInit import genSimInit

from dacToSim.DataModel.Project.DAC.Visualizations import getVisuFiles
from dacToSim.DataModel.Common import FileData
from dacToSim.constants.names.simMasterNames import ENUM_VISU, MAIN_VISU, SCREEN_INIT, BLANK_VISU


def createVisualizationStructure(visuPath:Path, project:MasterProject):
  # Create the visualization structure for the Master project
  visuPath.mkdir(parents=True, exist_ok=True)

  dacVisuNames : List[str] = []

  existingScreenNames = [file.name for file in getVisuFiles(visuPath)]
  existingScreenNames.sort()

  for projectSet in project.sets:
    dacProj = projectSet.dac[0]

    projVisuNames = []

    if dacProj.Visualizations:
      for visuFile in dacProj.Visualizations:
        projVisuNames.append(visuFile.name)
        # If a blank visualization file does not exist, create it
        # Cannot copy the DAC file due to different structure
        if not Path(visuPath / dacProj.Scheme.schemeName / visuFile.relPath).exists():
          writeFile(
            visuPath / dacProj.Scheme.schemeName / visuFile.relPath,
            BlankVisualization.format(name=visuFile.name),
            False
          )
    else:
      # If no DAC visualizations exist, create a default one
      name = BLANK_VISU.format(schemeName=dacProj.Scheme.schemeName)
      projVisuNames.append(name)
      writeFile(
        visuPath / f"{name}.xml",
        BlankVisualization.format(name=name),
        False
      )

    projVisuNames.sort()
    dacVisuNames.extend(projVisuNames)
  
  # Create a merged list of visualization names
  # Covers both DAC and existing screens allows for new screens to be added for the Master project
  mergedVisuNames = dacVisuNames
  for screenName in existingScreenNames:
    if screenName not in mergedVisuNames:
      mergedVisuNames.append(screenName)
  
  if not mergedVisuNames:
    mergedVisuNames = ["Screen1", "Screen2", "Screen3"]  # Default screens if none exist

  # Remove any empty strings from the merged list
  mergedVisuNames =[screen for screen in mergedVisuNames if screen.strip()]
 
  writeFile(
    visuPath / f"{ENUM_VISU}.xml",
    EnumVisuTemplate.format(
      pouName=ENUM_VISU,
      enums="\n".join(f"  {screen}," for screen in mergedVisuNames)[:-1] # Remove the last comma
    ),
    True
  )

  # Create the main visualization file
  # This will be the main entry point for the Master project visualizations
  mainVisPath = visuPath / f"{MAIN_VISU}.xml"
  writeFile(
    mainVisPath,
    genMainVisu(mergedVisuNames),
    True
  )

  # Create the SimInit file
  simInitPath = visuPath / f"{SCREEN_INIT}.xml"
  writeFile(
    simInitPath,
    genSimInit(
      enumName=ENUM_VISU,
      screenNames=mergedVisuNames
    ),
    True
  )