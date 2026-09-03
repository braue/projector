pattern = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <Device>
    <Name>{name}</Name>
    <Manufacturer>Any</Manufacturer>
    <Model>Other</Model>
    <Connection>
      <Protocol>DNPClient</Protocol>
      <ConnectionType>Ethernet</ConnectionType>
      <SettingPages>
        <SettingPage>
          <Name>Settings</Name>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Client DNP Address</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{clientDnpAddr}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Server DNP Address</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{serverDnpAddr}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Integrity Poll Period</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{integrityPollPeriod}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Class 1,2,3 Polling Period</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{eventPollPeriod}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Client IP Port</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{clientIpPort}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Server IP Address</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{serverIpAddr}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Server IP Port</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{serverIpPort}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Disable Unsolicited on Startup</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>False</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
        </SettingPage>
        <SettingPage>
          <Name>Binary Inputs</Name>
          {BinaryInputs}
        </SettingPage>
        <SettingPage>
          <Name>Double Bit Inputs</Name>
          {DoubleBitInputs}
        </SettingPage>
        <SettingPage>
          <Name>Binary Outputs</Name>
          {BinaryOutputs}
        </SettingPage>
        <SettingPage>
          <Name>Counters</Name>
          {Counters}
        </SettingPage>
        <SettingPage>
          <Name>Analog Inputs</Name>
          {AnalogInputs}
        </SettingPage>
        <SettingPage>
          <Name>Analog Outputs</Name>
          {AnalogOutputs}
        </SettingPage>
        <SettingPage>
          <Name>Datasets</Name>
          {Datasets}
        </SettingPage>
      </SettingPages>
    </Connection>
  </Device>
</RTACModule>
'''

import xml.etree.ElementTree as ET

ELEMENT_NAMES = {
  "Var Obj 1 Default",  "Var Obj 2 Default",  "Var Obj 3 Default",  "Var Obj 4 Default",
  "Var Obj 10 Default",  "Var Obj 20 Default",  "Var Obj 21 Default",  "Var Obj 22 Default",
  "Var Obj 23 Default",  "Var Obj 30 Default",  "Var Obj 32 Default",  "Var Obj 40 Default",
  "Frozen Event Class",  "Event Class",
}
def removeServerSettingsXML(body: str) -> str:
  tree = ET.ElementTree(ET.fromstring(body))
  root = tree.getroot()

  for row in root.findall('.//Row'):
    toRemove = []
    for setting in row.findall('Setting'):
      column = setting.find('Column')

      if column is not None and column.text in ELEMENT_NAMES:
        toRemove.append(setting)

    for settingToRemove in toRemove:
      row.remove(settingToRemove)

  return ET.tostring(root, encoding='unicode', method='xml')

def processPattern(name: str, clientDnpAddr: str, serverDnpAddr: str, integrityPollPeriod: str, eventPollPeriod: str, clientIpPort: str, serverIpAddr: str, serverIpPort: str, **kwargs) -> str:
  try:    
    results = pattern.format(
      name=name,
      clientDnpAddr=clientDnpAddr,
      serverDnpAddr=serverDnpAddr,
      integrityPollPeriod=integrityPollPeriod,
      eventPollPeriod=eventPollPeriod,
      clientIpPort=clientIpPort,
      serverIpAddr=serverIpAddr,
      serverIpPort=serverIpPort,
      **kwargs
    )
    return removeServerSettingsXML(results)

  except KeyError as e:
    print(kwargs.keys())
    raise ValueError(f"Missing required key in pattern: {e}") from e
  