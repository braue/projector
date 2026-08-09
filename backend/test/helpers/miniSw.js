// A hand-rolled minimal SEL-2730M settings export: four ports (eth3
// disabled, eth1 labeled), the default VLAN plus two static VLANs (one with a
// port range), and two management interfaces. Exercises single-element
// collapse (one address under Mgmt) and empty port lists.

const MINI_SW = `<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <Version major="1" minor="0" />
  <Nameplate>
    <Type>SEL-2730M</Type>
    <FID>SEL-2730M-R108-V1-Z007001-D20181228</FID>
    <Id>SW-STATION-A</Id>
    <PartNumber />
    <SerialNumber />
  </Nameplate>
  <Settings>
    <CompositeSetting name="vlan_settings">
      <Settings>
        <CompositeSetting name="default_vlan">
          <Settings>
            <Setting name="VL_NAME_ST"><Value>Default</Value></Setting>
            <Setting name="VL_TAGGEDPORTS_ST"><Value /></Setting>
          </Settings>
        </CompositeSetting>
        <CompositeSetting name="static_vlans">
          <Settings>
            <CompositeSetting instance="0" name="static_vlan">
              <Settings>
                <Setting name="VL_NAME_ST"><Value>GOOSE-BAY1</Value></Setting>
                <Setting name="VL_UNTAGGEDPORTS_ST"><Value>4</Value></Setting>
                <Setting name="VL_VID_ST"><Value>20</Value></Setting>
                <Setting name="VL_TAGGEDPORTS_ST"><Value>1,2</Value></Setting>
              </Settings>
            </CompositeSetting>
            <CompositeSetting instance="1" name="static_vlan">
              <Settings>
                <Setting name="VL_NAME_ST"><Value>SCADA</Value></Setting>
                <Setting name="VL_UNTAGGEDPORTS_ST"><Value /></Setting>
                <Setting name="VL_VID_ST"><Value>30</Value></Setting>
                <Setting name="VL_TAGGEDPORTS_ST"><Value>1-3</Value></Setting>
              </Settings>
            </CompositeSetting>
          </Settings>
        </CompositeSetting>
        <CompositeSetting name="vlan_aware_mode">
          <Settings>
            <Setting name="VL_AWARE_ST"><Value>True</Value></Setting>
          </Settings>
        </CompositeSetting>
      </Settings>
    </CompositeSetting>
    <CompositeSetting name="network_settings">
      <Settings>
        <CompositeSetting name="global_settings">
          <Settings>
            <Setting name="NI_HOSTNAME_ST"><Value>SW-STATION-A</Value></Setting>
            <Setting name="NI_DEFGW_ST"><Value>10.0.0.1</Value></Setting>
          </Settings>
        </CompositeSetting>
        <CompositeSetting name="interfaces">
          <Settings>
            <CompositeSetting instance="0" name="interface">
              <Settings>
                <CompositeSetting name="addresses">
                  <Settings>
                    <CompositeSetting instance="0" name="address">
                      <Settings>
                        <CompositeSetting name="applications">
                          <Settings>
                            <Setting name="HTTPS"><Value>True</Value></Setting>
                            <Setting name="SNMP"><Value>False</Value></Setting>
                          </Settings>
                        </CompositeSetting>
                        <Setting name="ip_address"><Value>10.0.0.30/24</Value></Setting>
                        <Setting name="alias"><Value>Mgmt</Value></Setting>
                      </Settings>
                    </CompositeSetting>
                  </Settings>
                </CompositeSetting>
                <Setting name="interface_id"><Value>Mgmt</Value></Setting>
                <Setting name="enabled"><Value>True</Value></Setting>
                <Setting name="alias"><Value>Mgmt</Value></Setting>
                <Setting name="vlan"><Value>1000</Value></Setting>
              </Settings>
            </CompositeSetting>
          </Settings>
        </CompositeSetting>
      </Settings>
    </CompositeSetting>
    <CompositeSetting name="port_settings">
      <Settings>
        <CompositeSetting name="ports">
          <Settings>
            <CompositeSetting instance="0" name="port">
              <Settings>
                <Setting name="PRTS_ENABLE_ST"><Value>True</Value></Setting>
                <Setting name="PRTS_SPDDPLX_ST"><Value>PRTS_1G_FULL</Value></Setting>
                <Setting name="port_id"><Value>eth1</Value></Setting>
                <Setting name="PRTS_NAME_ST"><Value>To RTAC</Value></Setting>
              </Settings>
            </CompositeSetting>
            <CompositeSetting instance="1" name="port">
              <Settings>
                <Setting name="PRTS_ENABLE_ST"><Value>True</Value></Setting>
                <Setting name="PRTS_SPDDPLX_ST"><Value>PRTS_AUTO</Value></Setting>
                <Setting name="port_id"><Value>eth2</Value></Setting>
                <Setting name="PRTS_NAME_ST"><Value /></Setting>
              </Settings>
            </CompositeSetting>
            <CompositeSetting instance="2" name="port">
              <Settings>
                <Setting name="PRTS_ENABLE_ST"><Value>False</Value></Setting>
                <Setting name="PRTS_SPDDPLX_ST"><Value>PRTS_AUTO</Value></Setting>
                <Setting name="port_id"><Value>eth3</Value></Setting>
                <Setting name="PRTS_NAME_ST"><Value /></Setting>
              </Settings>
            </CompositeSetting>
            <CompositeSetting instance="3" name="port">
              <Settings>
                <Setting name="PRTS_ENABLE_ST"><Value>True</Value></Setting>
                <Setting name="PRTS_SPDDPLX_ST"><Value>PRTS_100M_FULL</Value></Setting>
                <Setting name="port_id"><Value>eth4</Value></Setting>
                <Setting name="PRTS_NAME_ST"><Value>Feeder relay</Value></Setting>
              </Settings>
            </CompositeSetting>
          </Settings>
        </CompositeSetting>
      </Settings>
    </CompositeSetting>
  </Settings>
</Configuration>`;

export { MINI_SW };
