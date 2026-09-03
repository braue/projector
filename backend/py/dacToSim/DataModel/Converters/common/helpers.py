import re
from dacToSim.DataModel.Common.logicTypes import VarAssignment

from dacToSim.constants.regEx import defaultFlags
from dacToSim.DataModel.Device.Connections import ConnectionFiles
from dacToSim.DataModel.Profile import Scheme




RE_TAGMAP_NAME = re.compile(r"ADR\(\s*(\w+)_DNP\.(.*?)\)", defaultFlags)


def replacePouName(old:VarAssignment, newConnection:ConnectionFiles) -> str:
  if newConnection is None or newConnection.tagMap is None or not newConnection.tagMap.name:
    return None

  results = RE_TAGMAP_NAME.search(old.right)
  if results is None:
    return old.right
  else:
    pouName = newConnection.tagMap.name
    if "_DNP" not in pouName:
      pouName += "_DNP"
    tagName = results.group(2)
    return f"ADR({pouName}.{tagName})"
  



def getUniqueName(old:VarAssignment, scheme:Scheme) -> str:
  if old.right is None or old.right == '':
    return ''
  if scheme is None:
    return old.right
  return f"{scheme.schemeName}_{old.right}"