
import json
from typing import List,Dict, Tuple

from pathlib import Path


class schemeEquip:
  def __init__(self, subFolder: str, ipAddr: List[str]|str):
    self.subFolder:str = subFolder
    self.ipAddr:List[str]|str = ipAddr if isinstance(ipAddr, list) else [ipAddr]

  def toDict(self):
    return {
      "subFolder": self.subFolder,
      "ipAddr": self.ipAddr
    }
  
  def __str__(self):
    return json.dumps(self.toDict(), indent=2)
  
  def __repr__(self):
    return f"schemeEquip({','.join(f'{k}={v!r}' for k, v in self.toDict().items())})"

class nameConversion:
  def __init__(self, old: str='', new: str=''):
    self.old:str = old
    self.new:str = new

  def toDict(self):
    return {
      "old": self.old,
      "new": self.new
    }
  
  def __str__(self):
     return json.dumps(self.toDict(), indent=2)
  
  def __repr__(self):
     return f"nameConversion({', '.join(f'{k}={v!r}' for k, v in self.toDict().items())})"

class scheme:
  def __init__(self):
    self.schemeName:str = None
    self.subSimId:str = None
    self.dac:schemeEquip = None
    self.remote:schemeEquip = None
    self.logic:schemeEquip = None
    self.nameConversion:List[nameConversion] = []
    self.parameters:Dict[str,str] = {}

class Parameters:
  def __init__(self, **kwargs):
    for k, v in kwargs.items():
      setattr(self, k, v)

  def toDict(self):
    return {k: v for k, v in self.__dict__.items() if not k.startswith('_')}
  
  def __str__(self):
    return json.dumps(self.toDict(), indent=2)
  
  def __repr__(self):
    return f"Parameters({', '.join(f'{k}={v!r}' for k, v in self.toDict().items())})"

class Scheme:

  def __init__(self, schemeName: str, subSimId: str, dac: schemeEquip, remote: schemeEquip, logic: schemeEquip, nameConversions: List[nameConversion], parameters: Parameters):
    self.schemeName = schemeName
    self.subSimId = subSimId
    self.dac = dac
    self.remote = remote
    self.logic = logic
    self.nameConversions = nameConversions
    self.parameters = parameters

  def toDict(self):
    return {
      "schemeName": self.schemeName,
      "subSimId": self.subSimId,
      "dac": self.dac.__dict__,
      "remote": self.remote.__dict__,
      "logic": self.logic.__dict__,
      "nameConversions": [nc.__dict__ for nc in self.nameConversions],
      "parameters": self.parameters.__dict__
    }
  

  def __str__(self):
    return json.dumps(self.toDict(), indent=2)

  def __repr__(self):
    return f"Scheme({self.schemeName!r}, {self.subSimId!r}, dac={self.dac!r}, remote={self.remote!r}, logic={self.logic!r}, nameConversions={self.nameConversions!r}, parameters={self.parameters!r})"
  


def importSettings(filePath = Path().cwd() / 'settings.json') -> Tuple[List[Scheme], Path]:
  filePath = Path(filePath)
  if not filePath.is_file(): raise Exception( str(filePath) + " does not exist")


  # Convert JSON to class object
  data = json.loads(filePath.read_text())
  settings: List[Scheme] = []
  try:
    validate_scheme_json(data)
    settings.extend([Scheme(
        schemeName=item["schemeName"],
        subSimId=item["subSimId"],
        dac=schemeEquip(**item["dac"]),
        remote=schemeEquip(**item["remote"]),
        logic=schemeEquip(**item["logic"]),
        nameConversions=item["nameConversions"],
        parameters=Parameters(**item["parameters"])
    ) for item in data])
    
  except Exception as e:
    print(f"Error parsing JSON file {filePath}: {e}")
    print("An error occurred while reading or parsing the JSON file.")
    print("Please ensure the JSON file has the following structure:")
    print('''
[
  {
    "schemeName": "string",
    "subSimId": "string",
    "dac": {
      "subFolder": "string",
      "ipAddr": ["string"]
    },
    "remote": {
      "subFolder": "string",
      "ipAddr": ["string"]
    },
    "logic": {
      "subFolder": "string",
      "ipAddr": "string"
    },
    "nameConversions": [{
      "old": "string", 
      "new": "string"
    }],
    "parameters": {
      "defaultLoad": int
    }
  }
]
''')
    print(f"Error details: {e}")

  if len(settings) < 1: 
    raise Exception( str(filePath) + " is Empty or malformed")

  return settings, filePath.parents[0]




def validate_scheme_json(data: list) -> bool:
    """
    Validates the structure of the loaded JSON data for Scheme objects.
    Returns True if valid, raises Exception with details if not.
    """
    required_top_keys = {"schemeName", "subSimId", "dac", "remote", "logic", "nameConversions", "parameters"}
    required_equip_keys = {"subFolder", "ipAddr"}
    required_nameconv_keys = {"old", "new"}

    if not isinstance(data, list):
        raise Exception("Top-level JSON must be a list of scheme objects.")

    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            raise Exception(f"Item at index {idx} is not a dictionary.")

        missing = required_top_keys - item.keys()
        if missing:
            raise Exception(f"Item at index {idx} is missing required keys: {missing}")

        for equip in ["dac", "remote", "logic"]:
            equip_val = item[equip]
            if not isinstance(equip_val, dict):
                raise Exception(f"{equip} in item {idx} must be a dictionary.")
            missing_equip = required_equip_keys - equip_val.keys()
            if missing_equip:
                raise Exception(f"{equip} in item {idx} is missing keys: {missing_equip}")

        # nameConversions should be a list of dicts with 'old' and 'new'
        if not isinstance(item["nameConversions"], list):
            raise Exception(f"nameConversions in item {idx} must be a list.")
        for nc_idx, nc in enumerate(item["nameConversions"]):
            if not isinstance(nc, dict):
                raise Exception(f"nameConversions[{nc_idx}] in item {idx} must be a dict.")
            missing_nc = required_nameconv_keys - nc.keys()
            if missing_nc:
                raise Exception(f"nameConversions[{nc_idx}] in item {idx} missing keys: {missing_nc}")

        # parameters should be a dict (arbitrary keys allowed)
        if not isinstance(item["parameters"], dict):
            raise Exception(f"parameters in item {idx} must be a dictionary.")

    return True