from pathlib import Path
from typing import List, Tuple, Dict

from dacToSim.constants.names import folders, fileNames
from dacToSim.constants.projectTypes import REMOTE_IO, LOGIC
from dacToSim.constants.names.simMasterNames import DEV_DEC_SOURCES, INIT_XFMR
from dacToSim.common import writeFile


from dacToSim.DataModel.Common import VarAssignment,Method
from dacToSim.DataModel.Device import Device
from dacToSim.DataModel.Device.Declaration import DeviceDeclaration
from dacToSim.DataModel.Device.Initialization import DeviceInitialization

from dacToSim.DataModel.Project import DacProject, RemProject, MasterProject, ProjectSet
from dacToSim.DataModel.Project.Libraries import buildLibrary
from dacToSim.DataModel.Profile import nameConversion as deviceNameConversion
from dacToSim.SpecialFiles.SystemTime import writedMasterSystemTime

from .Declarations import buildDeviceDeclaration, processDevDec
from .Definitions import buildDeviceDefinitions
from .Devices import setInterconnectLocalDacName
from .Initializations import buildInitialization, processInit

from .RemoteIO import buildMasterBackPlane
from .Visualizations import createVisualizationStructure
from .Gateway import GatewayPou, buildMasterGateway, buildRemoteIoGateway
from .AreaMap import convertAreaMap, updateMasterAreaMap

from dacToSim.constants.names import simMasterNames as patterns




def buildMasterProject(project:MasterProject):
  for projectSet in project.sets:
    # Update the Dac project
    for dac in projectSet.dac:
      updateDac(dac)

      processDevDec(projectSet.paths.declarations / f"{patterns.DEV_DEC_SOURCES.format(schemeName=dac.Scheme.schemeName)}.xml", dac)
      processInit(projectSet.paths.initialization / f"{patterns.INIT_XFMR.format(schemeName=dac.Scheme.schemeName)}.xml", dac)

  return None

def updateDac(dacProject:DacProject):
  # Device Declaration
  # Process user defined name conversions
  for nameConversion in dacProject.Scheme.nameConversions:
    old : str  = nameConversion.old
    new : str = nameConversion.new
    if not old or not new:
      continue
    for devDec in dacProject.DevDec:
      for dev in devDec.declarations:
        if dev.name.upper() == old.upper():
          dev.name = new
          break

  schemeName = dacProject.Scheme.schemeName
  for devDec in dacProject.DevDec:
    devDec.UpdateName(patterns.DEV_DEC.format(schemeName=schemeName, name=devDec.name))
    for dev in devDec.declarations:
      dev.type = dev.type.replace("DA_","SIM_")

      if dev.makeMasterUnique:
        dacProject.Scheme.nameConversions.append(
          deviceNameConversion(
            old=dev.name,
            new=patterns.UNIQUE_NAME.format(schemeName=schemeName, name=dev.name)
          )
        )
        dev.name = patterns.DEV_DEC.format(schemeName=schemeName, name=dev.name)

  for devDef in dacProject.DevDef:
    devDef.UpdateName(patterns.DEV_DEF.format(schemeName=schemeName, name=devDef.name))

  for init in dacProject.Inits:
    init.UpdateName(patterns.INIT.format(schemeName=schemeName, name=init.name))

  setInterconnectLocalDacName(dacProject.Devices)

  # Remove the connections being handled by the RemoteIO project(s)
  for device in dacProject.Devices:
    device.scada = None
    device.field = None
  
def writeMasterProjectFiles(project:MasterProject):
  gateways : List[GatewayPou] = []

  exitingSources = set()
  for projectSet in project.sets:
    writeMasterProjectDacAreaMapFiles(projectSet)

    for devDec in projectSet.dac[0].DevDec:
      exitingSources.update([devName.upper() for devName in devDec.getNameOfType("SUB_TRANSFORMER")])


  # newAreaSources[schemeName] = []
  newAreaSources : Dict[str,List[str]] = {}
  # Write master area map
  areaMapPath = project.paths.areaMap / f"AreaMap.xml"
  writeFile(
    areaMapPath,
    updateMasterAreaMap(areaMapPath, project, newAreaSources),
    True
  )
  
  # Filter out duplicate new area sources
  filterNewAreaSources : Dict[str,List[str]] = {}

  for schemeName, sources in newAreaSources.items():
    for source in sources:
      if source not in exitingSources:
        exitingSources.add(source)
        if schemeName not in filterNewAreaSources:
          filterNewAreaSources[schemeName] = []
        filterNewAreaSources[schemeName].append(source)

  # Create scaffolded initialization for new DevDec_Source in {schemeName}_Init_Xfmr
  for projectSet in project.sets:
    dac : DacProject = projectSet.dac[0]
    if dac.Scheme.schemeName not in filterNewAreaSources:
      continue

    addNewSimTransformers(dac, filterNewAreaSources[dac.Scheme.schemeName])

  for projectSet in project.sets:
    currGatewayRoots = writeMasterProjectDacFiles(projectSet)
    gateways.extend(currGatewayRoots)

  # Add libraries
  for library in project.sets[0].rem[0].Libraries:
    writeFile(
      project.paths.libraries / f"{library.name}.xml",
      buildLibrary(library),
      True
    )


  # Write master gateway POU file
  writeFile(
    project.paths.gateway / "Gateway.xml",
    buildMasterGateway(gateways, project.sets[0].dac[0].Scheme.logic.ipAddr),
    True
  )

  writedMasterSystemTime(project.paths.system)

  createVisualizationStructure(project.paths.visualizations, project)

def writeMasterProjectDacAreaMapFiles(projectSet:ProjectSet):
  dac : DacProject = projectSet.dac[0]

  # AreaMap
  areaMap = f"{dac.Scheme.schemeName}_AreaMap"
  targetPath = projectSet.paths.areaMap / f"{areaMap}.xml"
  writeFile(
    targetPath,
    convertAreaMap(dac.AreaMap, dac.Scheme.schemeName, dac.DevDec, dac.Scheme.nameConversions, targetPath),
    True
  )


def writeMasterProjectDacFiles(projectSet:ProjectSet) -> List[GatewayPou]:
  ''' Write the Dac files for the Master project '''
  
  gatewayRoots : List[GatewayPou] = []
  dac : DacProject = projectSet.dac[0]

  # Device Declaration
  for devDec in dac.DevDec:
    writeFile(
      projectSet.paths.declarations / f"{devDec.name}.xml",
      buildDeviceDeclaration(devDec),
      True
    )

  # Device Definitions
  for devDef in dac.DevDef:
    writeFile(
      projectSet.paths.definitions / f"{devDef.name}.xml",
      buildDeviceDefinitions(devDef),
      True
    )

  # Initializations
  for init in dac.Inits:
    writeFile(
      projectSet.paths.initialization / f"{init.name}.xml",
      buildInitialization(init, dac.Scheme, LOGIC),
      True
    )

  # Gateway
  for remIO in projectSet.rem:
    gateway = GatewayPou(
      projectSet.paths.initId,
      dac.Name, dac.IpAddr,
      remIO.Name, remIO.IpAddr
    )
    gatewayRoots.append(gateway)
    
    writeFile(
      projectSet.paths.gateway / f"{gateway.pouName}.xml",
      buildRemoteIoGateway(
        gateway.pouName,
        remIO.Gateway.field,
        remIO.Gateway.scada
      ),
      True
    )

  if gatewayRoots:
    # Remote IO
    writeFile(
      projectSet.paths.remoteIO / f"{patterns.INIT_REMOTE_IO.format(schemeName=dac.Scheme.schemeName)}.xml",
      buildMasterBackPlane(dac.Scheme, gatewayRoots[0].simIpVarName ),
      True
    )


  return gatewayRoots



def addNewSimTransformers(project: DacProject, newTransformers: List[str]):
    """ Add new SIM_SUB_TRANSFORMERS to the DAC project
    """
    sourceDevDec = None
    for devDec in project.DevDec:
      if devDec.name == DEV_DEC_SOURCES.format(schemeName=project.Scheme.schemeName):
        sourceDevDec = devDec
        break
 
    if sourceDevDec is None:
      raise ValueError(f"Device declaration source not found for scheme {project.Scheme.schemeName}")
    
    initXfmr = None
    for init in project.Inits:
      if init.name == INIT_XFMR.format(schemeName=project.Scheme.schemeName):
        initXfmr = init
        break
    if initXfmr is None:
      print(f"Source Initialization  not found for scheme {project.Scheme.schemeName}")
      print("Creating new source initialization ")
      initXfmr = DeviceInitialization(name=INIT_XFMR.format(schemeName=project.Scheme.schemeName))
      project.Inits.append(initXfmr)
    

    for transformerName in newTransformers:
      # Create a new Device for the new transformer
      newDevice = Device(deviceDeclaration=DeviceDeclaration(
        parentName=sourceDevDec.name,
        name=transformerName,
        type="SIM_SUB_TRANSFORMER",
        makeMasterUnique=False
      ))
      sourceDevDec.append(newDevice.deviceDeclaration)

      project.Devices.append(newDevice)

      

      newDevice.initialization = DeviceInitialization(name=transformerName)
      initXfmr.devices.add(newDevice)

      # TODO: Default values for the transformer should auto populate the rest
      newDevice.initialization.AppendMethod(Method().fromList(name='mInit', inputs=[
        VarAssignment().fromInputs("Name", f"'{transformerName}'",'')
      ], outputs=[]))

      
