from dacToSim.DataModel.Common.logicTypes import VarAssignment


class DeviceRule:
  def __init__(self, name: str, parameters: VarAssignment|list[VarAssignment], dacName: str = ''):
    self.name = name
    self.dacName = dacName
    self.parameters = parameters

  @property
  def lookupName(self) -> str:
    if self.dacName:
      return self.dacName
    return self.name
  


class DeviceRules:
  def __init__(self):
    self.call: DeviceRule | None = None
    self.methods: list[DeviceRule] = []
    self.properties: list[DeviceRule] = []