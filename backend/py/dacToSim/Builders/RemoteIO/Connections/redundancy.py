from typing import List
from pathlib import Path

from dacToSim.common import writeFile


from dacToSim.Builders.Common.Redundancy.genTagPairs import genTagPairs, getTagSymbolCheck
from dacToSim.DataModel.Device.Connections import ConnectionFiles

from dacToSim.constants.names.simRemoteIoNames import REDUNDANCY, TAG_SYMBOL_CHECK


def writeRedundancyPous(logicPath:Path, pouPath:Path, dacIpAddrs : str|List[str], clients : List[ConnectionFiles]) -> None:
  if isinstance(dacIpAddrs, str) or len(dacIpAddrs) <= 1 or not clients:
    return

  writeFile(
    logicPath / f"{REDUNDANCY}.xml",
    genTagPairs(
      pouName=REDUNDANCY,
      dacIpAddrs= dacIpAddrs,
      scadaMaps= clients
    ),
    True
  )
  writeFile(
    pouPath / 'StaysInPous' / f'{TAG_SYMBOL_CHECK}.xml',
    getTagSymbolCheck(),
    True
  )