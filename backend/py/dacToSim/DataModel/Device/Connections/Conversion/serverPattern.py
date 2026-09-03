


pattern = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <Device>
    <Name>{name}</Name>
    <Manufacturer>Any</Manufacturer>
    <Model>Other</Model>
    <Connection>
      <Protocol>DNPServer</Protocol>
      <ConnectionType>Ethernet</ConnectionType>
      <SettingPages>
        <SettingPage>
          <Name>Settings</Name>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Server IP Port</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{serverIpPortSim}</Value>
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
              <Value>Client IP Addresses</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{clientIpAddr}</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
          <Row>
            <Setting enabled="false">
              <Column>Setting</Column>
              <Value>Map Name</Value>
            </Setting>
            <Setting>
              <Column>Value</Column>
              <Value>{serverMapName}_DNP</Value>
            </Setting>
            <Setting>
              <Column>Comment</Column>
              <Value />
            </Setting>
          </Row>
        </SettingPage>
      </SettingPages>
    </Connection>
  </Device>
</RTACModule>'''

def processPattern(name:str, serverIpPortSim:int, serverDnpAddr:int, clientDnpAddr:int,  clientIpAddr:str, serverMapName:str) -> str:
  """
  Process the server pattern with the provided parameters.
  
  :param name: Name of the connection.
  :param serverIpPortSim: Server IP port for simulation.
  :param serverDnpAddr: Server DNP address.
  :param clientDnpAddr: Client DNP address.
  
  :param clientIpAddr: IP Address of the gateway client.
  :param serverMapName: Name of the server map.
  :return: Formatted XML string based on the pattern.
  """
  return pattern.format(
    name=name,
    serverDnpAddr=serverDnpAddr,
    clientDnpAddr=clientDnpAddr,
    serverIpPortSim=serverIpPortSim,
    clientIpAddr=clientIpAddr,
    serverMapName=serverMapName
  )