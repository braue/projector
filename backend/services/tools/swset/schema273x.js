// SEL-273x editing schema — transcribed from the old SWSET tool's
// functions.py (XMLtoExcel / ExceltoXML). Table/field labels mirror the old
// Excel workbook's tables; paths are xmlGet/xmlSet path arrays (see ./xml.js)
// and preserve the old tool's exact XML spellings. Fields the old tool read
// into Excel but never wrote back are marked readOnly; create:true is carried
// wherever ExceltoXML passed create=True.

/**
 * @typedef {object} Field
 * @property {string} id
 * @property {string} label            Excel column/row label from the old workbook.
 * @property {(string|number)[]} path  xmlGet/xmlSet path array.
 * @property {boolean} [create]        Write with { create: true } (old tool used create=True).
 * @property {boolean} [readOnly]      Old tool read this but never wrote it back.
 */

/**
 * @typedef {object} Column
 * @property {string} id
 * @property {string} label
 * @property {(string|number)[]} [key]  Path suffix appended to base+[rowIndex]. Absent when `fixed` is set.
 * @property {boolean} [create]         Write with { create: true }.
 * @property {boolean} [readOnly]       Shown but never written back.
 * @property {string} [fixed]           Constant display value; never read from or written to the XML.
 */

/**
 * @typedef {object} NameplateTable
 * @property {'nameplate'} kind
 * @property {string} id
 * @property {string} label
 * @property {{ id: string, label: string, key: string }[]} fields  key = property on the Nameplate object.
 */

/**
 * @typedef {object} FieldsTable
 * @property {'fields'} kind
 * @property {string} id
 * @property {string} label
 * @property {Field[]} fields
 */

/**
 * @typedef {object} ListTable
 * @property {'list'} kind
 * @property {string} id
 * @property {string} label
 * @property {(string|number)[]} base   XML array whose length drives the row count.
 * @property {Column[]} columns
 * @property {boolean} [canAddRows]     ExceltoXML created brand-new rows here (create=True with its own index).
 * @property {object} [addDefaults]     Values (by column id) the old tool seeded blank cells of new rows with.
 */

/**
 * @typedef {NameplateTable|FieldsTable|ListTable} Table
 */

/**
 * @typedef {object} Section
 * @property {string} id
 * @property {string} label
 * @property {Table[]} tables
 */

// The nine alarm triggers, in the old tool's row order:
// [name, enable key (alarm_settings), behavior key (alarm_signal_settings)].
const ALARM_TRIGGERS = [
  ['Auth', 'IO_ALMAUTH_ST', 'IO_ALMAUTH_TYPE_ST'],
  ['Chassis', 'IO_ALMCHASSIS_ST', 'IO_ALMCHASSIS_TYPE_ST'],
  ['Config', 'IO_ALMCONFIG_ST', 'IO_ALMCONFIG_TYPE_ST'],
  ['Eth Fault', 'IO_ALMETHF_ST', 'IO_ALMETHF_TYPE_ST'],
  ['Link Up/Down', 'IO_ALMLINKUPDOWN_ST', 'IO_ALMLINKUPDOWN_TYPE_ST'],
  ['Port Monitor', 'IO_ALMPORTMONITOR_ST', 'IO_ALMPORTMONITOR_TYPE_ST'],
  ['Port Security', 'IO_ALMPORTSECURITY_ST', 'IO_ALMPORTSECURITY_TYPE_ST'],
  ['STP', 'IO_ALMSTP_ST', 'IO_ALMSTP_TYPE_ST'],
  ['System Integrity', 'IO_ALMSYSINTEGRITY_ST', 'IO_ALMSYSINTEGRITY_TYPE_ST'],
];

const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/**
 * The SEL-273x family editing schema, resolved for one device.
 * @param {object} nameplate  Configuration.Nameplate as parsed (keys like Type, Id, FID, PartNumber, SerialNumber, SettingsVersionNumber)
 * @returns {{ sections: Section[] }}
 */
export function buildSchema273x(nameplate) {
  // XMLtoExcel/ExceltoXML both branch on '2731' in the nameplate Type for the
  // network-interface key names; resolve to concrete paths here.
  const is2731 = String(nameplate?.Type ?? '').includes('2731');
  const gatewayKey = is2731 ? 'NI_DEFAULT_GW_4_ST' : 'NI_DEFGW_ST';
  const enabledKey = is2731 ? 'NI_ENABLED_IP_ST' : 'enabled';
  const addr1 = is2731 ? 'ip_configurations' : 'addresses';
  const addr2 = is2731 ? 'ip_configuration' : 'address';
  const ipKey = is2731 ? 'NI_ADDR_IP_ST' : 'ip_address';
  const httpsKey = is2731 ? 'NI_HTTPS_EN_ST' : 'HTTPS';
  const captiveKey = is2731 ? 'NI_CAPTIVEPORT_EN_ST' : 'Captive Port';
  const snmpKey = is2731 ? 'NI_SNMP_EN_ST' : 'SNMP';

  const system = {
    id: 'system',
    label: 'System',
    tables: [
      {
        kind: 'nameplate',
        id: 'tbl_Nameplate',
        label: 'Nameplate',
        fields: [
          { id: 'type', label: 'Type', key: 'Type' },
          { id: 'deviceId', label: 'ID', key: 'Id' },
          { id: 'fid', label: 'FID', key: 'FID' },
          { id: 'settingsVersion', label: 'Settings Version', key: 'SettingsVersionNumber' },
          { id: 'partNumber', label: 'Part Number', key: 'PartNumber' },
          { id: 'serialNumber', label: 'Serial Number', key: 'SerialNumber' },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_Global',
        label: 'Global',
        fields: [
          { id: 'language', label: 'Language', path: ['locale', 'language', 'GS_DEFAULTLANGUAGE_ST'] },
          { id: 'maxSessions', label: 'Maximum Sessions', path: ['web_server_settings', 'user_session_settings', 'GS_MAXUSERS_ST'] },
          { id: 'sessionTimeout', label: 'Session Timeout', path: ['web_server_settings', 'user_session_settings', 'GS_TIMEOUT_ST'] },
          { id: 'contact', label: 'Contact', path: ['device_contact', 'contact_info', 'GS_CONTACT_ST'] },
          { id: 'location', label: 'Location', path: ['device_contact', 'contact_info', 'GS_LOCATION_ST'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_TimeNTP',
        label: 'Time / NTP',
        fields: [
          { id: 'timeZone', label: 'Time Zone', path: ['date_time', 'time_zone', 'DT_TIMEZONE_ST'] },
          { id: 'enableNtp', label: 'Enable NTP', path: ['date_time', 'time_sources', 'DT_ENABLENTPCLIENT_ST'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_NTPServers',
        label: 'NTP Servers',
        fields: [0, 1, 2].map((i) => ({
          id: `ntpServer${i + 1}`,
          label: `NTP Server ${i + 1}`,
          path: ['date_time', 'ntp_servers', 'ntp_server', i, 'DT_NTPSERVER_ST'],
        })),
      },
      {
        kind: 'fields',
        id: 'tbl_AlarmPulse',
        label: 'Alarm Pulse',
        fields: [
          { id: 'onTime', label: 'On Time (s)', path: ['alarm_contact', 'alarm_time_settings', 'IO_ALMONTIME_ST'] },
          { id: 'offTime', label: 'Off Time (s)', path: ['alarm_contact', 'alarm_time_settings', 'IO_ALMOFFTIME_ST'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_AlarmTrigger',
        label: 'Alarm Triggers',
        fields: ALARM_TRIGGERS.flatMap(([name, enableKey, behaviorKey]) => [
          {
            id: `${slug(name)}-enable`,
            label: `${name} alarm — Enable`,
            path: ['alarm_contact', 'alarm_settings', enableKey],
          },
          {
            id: `${slug(name)}-behavior`,
            label: `${name} alarm — Behavior`,
            path: ['alarm_contact', 'alarm_signal_settings', behaviorKey],
          },
        ]),
      },
    ],
  };

  const switchManagement = {
    id: 'switch',
    label: 'Switch Management',
    tables: [
      {
        kind: 'fields',
        id: 'tbl_VLANAware',
        label: 'VLAN Aware',
        fields: [
          { id: 'vlanAware', label: 'VLAN Aware', path: ['vlan_settings', 'vlan_aware_mode', 'VL_AWARE_ST'] },
        ],
      },
      // The old workbook's tbl_VLAN first row was the default VLAN (VID fixed
      // 1, Type fixed 'Default'); modeled here as its own fields table above
      // the static VLAN list, per the schema convention.
      {
        kind: 'fields',
        id: 'tbl_VLAN_default',
        label: 'Default VLAN (VID 1)',
        fields: [
          { id: 'name', label: 'Name', path: ['vlan_settings', 'default_vlan', 'VL_NAME_ST'], create: true },
          { id: 'taggedPorts', label: 'Tagged Ports', path: ['vlan_settings', 'default_vlan', 'VL_TAGGEDPORTS_ST'], create: true },
          { id: 'untaggedPorts', label: 'Untagged Ports', path: ['vlan_settings', 'default_vlan', 'VL_UNTAGGEDPORTS_ST'], create: true },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_VLAN',
        label: 'Static VLANs',
        base: ['vlan_settings', 'static_vlans', 'static_vlan'],
        canAddRows: true,
        addDefaults: { taggedPorts: '', untaggedPorts: '' },
        columns: [
          { id: 'vid', label: 'VID', key: ['VL_VID_ST'], create: true },
          { id: 'name', label: 'Name', key: ['VL_NAME_ST'], create: true },
          { id: 'taggedPorts', label: 'Tagged Ports', key: ['VL_TAGGEDPORTS_ST'], create: true },
          { id: 'untaggedPorts', label: 'Untagged Ports', key: ['VL_UNTAGGEDPORTS_ST'], create: true },
          { id: 'type', label: 'Type', fixed: 'Static' },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_RSTP',
        label: 'RSTP',
        fields: [
          { id: 'stpMode', label: 'STP Mode', path: ['SEL_RSTP', 'Global Settings', 'STP_MODE_ST'] },
          { id: 'bridgePriority', label: 'Bridge Priority', path: ['SEL_RSTP', 'Global Settings', 'STP_BRIDGEPRIORITY_ST'] },
          { id: 'helloTime', label: 'Hello Time', path: ['SEL_RSTP', 'Global Settings', 'STP_HELLOTIME_ST'] },
          { id: 'maxAge', label: 'Max Age', path: ['SEL_RSTP', 'Global Settings', 'STP_MAXAGE_ST'] },
          { id: 'forwardDelay', label: 'Forward Delay', path: ['SEL_RSTP', 'Global Settings', 'STP_FWDDELAY_ST'] },
          { id: 'bpduTimeoutEnable', label: 'BPDU Timeout Enable', path: ['SEL_RSTP', 'Global Settings', 'STP_BPDU_TIMEOUT_EN_ST'] },
          { id: 'bpduTimeout', label: 'BPDU Timeout (min)', path: ['SEL_RSTP', 'Global Settings', 'STP_BPDU_TIMEOUT_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_RSTPPorts',
        label: 'RSTP Ports',
        base: ['SEL_RSTP', 'Ports', 'Port'],
        columns: [
          { id: 'port', label: 'Port', key: ['port_id'] },
          { id: 'priority', label: 'Priority', key: ['STP_PRT_PRIORITY_ST'] },
          { id: 'pathCost', label: 'Path Cost', key: ['STP_PRT_PATHCOST_ST'] },
          { id: 'stpMode', label: 'STP Mode', key: ['STP_PORT_MODE_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_MulticastMAC',
        label: 'Multicast MAC Filters',
        base: ['multicast_mac_filter', 'mac_filters', 'mac_filter'],
        columns: [
          { id: 'ports', label: 'Ports', key: ['MF_PORTS_ST'] },
          { id: 'macAddress', label: 'MAC Address', key: ['MF_MCASTMACADD_ST'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_Mirror',
        label: 'Port Mirror',
        fields: [
          { id: 'enable', label: 'Enable', path: ['port_mirror', 'mirror_settings', 'PM_ENABLE_ST'] },
          { id: 'targetPort', label: 'Target Port', path: ['port_mirror', 'mirror_settings', 'PM_TARGET_ST'] },
          { id: 'ingress', label: 'Ingress', path: ['port_mirror', 'mirror_settings', 'PM_INGRESS_ST'] },
          { id: 'egress', label: 'Egress', path: ['port_mirror', 'mirror_settings', 'PM_EGRESS_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_PortSettings',
        label: 'Port Settings',
        base: ['port_settings', 'ports', 'port'],
        columns: [
          { id: 'port', label: 'Port', key: ['port_id'] },
          { id: 'enabled', label: 'Enabled', key: ['PRTS_ENABLE_ST'] },
          { id: 'fefi', label: 'Far End Fault Indication', key: ['PRTS_FEFI_ST'] },
          { id: 'alias', label: 'Alias', key: ['PRTS_NAME_ST'] },
          { id: 'speedDuplex', label: 'Speed/Duplex', key: ['PRTS_SPDDPLX_ST'] },
          { id: 'ingressRate', label: 'Ingress Rate', key: ['RL_ING_RATE_ST'] },
          { id: 'ingressType', label: 'Ingress Type', key: ['RL_INGRESS_TYPE_ST'] },
          { id: 'egressRate', label: 'Egress Rate', key: ['RL_EG_RATE_ST'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_Transmission',
        label: 'Transmission Policy',
        fields: [
          { id: 'transmissionPolicy', label: 'Transmission Policy', path: ['cos', 'cos_algorithm', 'CS_COSWEIGHING_ST'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_PCP',
        label: 'PCP Priorities',
        fields: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
          id: `pcp${i}`,
          label: `PCP ${i} — Priority`,
          path: ['cos', 'cos_priority', `CS_PCP_${i}_PRI`],
        })),
      },
      {
        kind: 'list',
        id: 'tbl_DSCP',
        label: 'DSCP Mappings',
        base: ['qos_settings', 'diffserv_mappings', 'diffserv_mapping'],
        columns: [
          { id: 'dscp', label: 'DSCP', key: ['DIFFSERV_DSCP_ST'] },
          { id: 'priority', label: 'Priority', key: ['DIFFSERV_PRI_ST'] },
        ],
      },
    ],
  };

  const network = {
    id: 'network',
    label: 'Network Settings',
    tables: [
      {
        kind: 'fields',
        id: 'tbl_IPGlobal',
        label: 'IP Global',
        fields: [
          { id: 'hostname', label: 'Hostname', path: ['network_settings', 'global_settings', 'NI_HOSTNAME_ST'] },
          { id: 'domainName', label: 'Domain Name', path: ['network_settings', 'global_settings', 'NI_DOMNAME_ST'] },
          { id: 'defaultGateway', label: 'Default Gateway', path: ['network_settings', 'global_settings', gatewayKey] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_IP',
        label: 'Interfaces',
        base: ['network_settings', 'interfaces', 'interface'],
        columns: [
          { id: 'interface', label: 'Interface', key: ['interface_id'] },
          { id: 'enabled', label: 'Enabled', key: [enabledKey] },
          { id: 'ipAddress', label: 'IP Address', key: [addr1, addr2, 0, ipKey] },
          { id: 'https', label: 'HTTPS', key: [addr1, addr2, 0, 'applications', httpsKey] },
          { id: 'captivePort', label: 'Captive Port', key: [addr1, addr2, 0, 'applications', captiveKey] },
          { id: 'snmp', label: 'SNMP', key: [addr1, addr2, 0, 'applications', snmpKey] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_SNMPHost',
        label: 'SNMP Hosts',
        base: ['snmp', 'hosts', 'host'],
        columns: [
          { id: 'hostAlias', label: 'Host Alias', key: ['SNMP_HOSTALIAS_ST'] },
          { id: 'hostRange', label: 'Host Range', key: ['SNMP_ACL_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_SNMPv2c',
        label: 'SNMP v2c Users',
        base: ['snmp', 'v2c_users', 'v2c_user'],
        columns: [
          { id: 'profile', label: 'v2c Profile', key: ['SNMP_PROFILE_ALIAS_ST'] },
          { id: 'read', label: 'Read', key: ['SNMP_V2C_READ_ST'] },
          { id: 'trap', label: 'Trap', key: ['SNMP_V2C_TRAP_ST'] },
          { id: 'readOnlyString', label: 'Read-Only String', key: ['SNMP_ROSTRING_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_SNMPv3',
        label: 'SNMP v3 Users',
        base: ['snmp', 'v3_users', 'v3_user'],
        columns: [
          { id: 'profile', label: 'v3 Profile', key: ['SNMP_USER_ST'] },
          { id: 'read', label: 'Read', key: ['SNMP_V3_READ_ST'] },
          { id: 'trap', label: 'Trap', key: ['SNMP_V3_TRAP_ST'] },
          { id: 'authProtocol', label: 'Auth Protocol', key: ['SNMP_AUTHPROTO_ST'] },
          { id: 'authPassword', label: 'Auth Password', key: ['SNMP_AUTHPASS_ST'] },
          { id: 'encryptionProtocol', label: 'Encryption Protocol', key: ['SNMP_ENCPROTO_ST'] },
          { id: 'encryptionPassword', label: 'Encryption Password', key: ['SNMP_ENCPASS_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_SNMPTRAP',
        label: 'SNMP Trap Servers',
        base: ['snmp', 'trap_servers', 'trap_server'],
        columns: [
          { id: 'trapAlias', label: 'TRAP Alias', key: ['SNMP_TRAP_ALIAS_ST'] },
          { id: 'user', label: 'User', key: ['SNMP_TRAP_USER_ST'] },
          { id: 'ipAddress', label: 'IP Address', key: ['SNMP_TRAP_DEST_ST'] },
          { id: 'authentication', label: 'Authentication', key: ['SNMP_TRAPS_ST', 'Authentication'] },
          { id: 'chassis', label: 'Chassis', key: ['SNMP_TRAPS_ST', 'Chassis'] },
          { id: 'configuration', label: 'Configuration', key: ['SNMP_TRAPS_ST', 'Configuration'] },
          { id: 'ethF', label: 'ETH F', key: ['SNMP_TRAPS_ST', 'ETH F'] },
          { id: 'link', label: 'Link', key: ['SNMP_TRAPS_ST', 'Link'] },
          { id: 'portSecurity', label: 'Port Security', key: ['SNMP_TRAPS_ST', 'Port Security'] },
          { id: 'spanningTree', label: 'Spanning Tree', key: ['SNMP_TRAPS_ST', 'Spanning Tree'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_SyslogLocal',
        label: 'Syslog Local',
        fields: [
          { id: 'localThreshold', label: 'Local Threshold', path: ['syslog_settings', 'syslog_general', 'SL_LOCALTHRESH_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_SyslogServer',
        label: 'Syslog Servers',
        base: ['syslog_settings', 'syslog_servers', 'syslog_server'],
        columns: [
          { id: 'alias', label: 'Alias', key: ['SL_SVRALIAS_ST'] },
          { id: 'ipAddress', label: 'IP Address', key: ['SL_SVRIP_ST'] },
          { id: 'threshold', label: 'Threshold', key: ['SL_SVRTHRESH_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_Hosts',
        label: 'Hosts',
        base: ['hosts_settings', 'Hosts', 'Host'],
        columns: [
          { id: 'hostname', label: 'Hostname', key: ['NR_HOSTNAME'] },
          { id: 'ipAddress', label: 'IP Address', key: ['NR_IPADDRESS'] },
        ],
      },
    ],
  };

  const accounts = {
    id: 'accounts',
    label: 'Accounts',
    tables: [
      {
        kind: 'list',
        id: 'tbl_LocalUser',
        label: 'Local Users',
        base: ['users', 'user_accounts', 'user_account'],
        columns: [
          { id: 'username', label: 'Username', key: ['UM_USERNAME_ST'] },
          { id: 'role', label: 'Role', key: ['UM_USERROLE_ST'] },
          { id: 'enabled', label: 'Enabled', key: ['UM_ACCOUNTENABLED_ST'] },
          { id: 'password', label: 'Password', key: ['UM_PASSWORD_ST'] },
          { id: 'hashedPassword', label: 'Hashed Password', key: ['password_hashed'] },
          { id: 'complexPassword', label: 'Complex Password', key: ['UM_COMPLEXPASSWORD_ST'] },
          { id: 'creationDate', label: 'Creation Date', key: ['account_creation_dt'] },
          { id: 'lastLogin', label: 'Last Login', key: ['last_access_dt'] },
          { id: 'passwordChange', label: 'Password Change', key: ['password_change_dt'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_LDAPGeneral',
        label: 'LDAP General',
        fields: [
          { id: 'enabled', label: 'Enabled', path: ['SEL_LDAP_CLIENT', 'General Settings', 'EN_LDAP'] },
          { id: 'tlsRequired', label: 'TLS Required', path: ['SEL_LDAP_CLIENT', 'General Settings', 'LDAP_EN_TLS'] },
          { id: 'syncInterval', label: 'Sync Interval (h)', path: ['SEL_LDAP_CLIENT', 'General Settings', 'LDAP_SYNC'] },
          { id: 'searchBase', label: 'Search Base', path: ['SEL_LDAP_CLIENT', 'General Settings', 'SEARCH_BASE'] },
          { id: 'groupMembershipAttribute', label: 'Group Membership Attribute', path: ['SEL_LDAP_CLIENT', 'General Settings', 'MEM_ATTR'] },
          { id: 'userIdFilter', label: 'User ID Filter', path: ['SEL_LDAP_CLIENT', 'General Settings', 'USER_ID_FILTER'] },
          { id: 'groupFilter', label: 'Group Filter', path: ['SEL_LDAP_CLIENT', 'General Settings', 'GROUP_FILTER'] },
          { id: 'bindDn', label: 'Bind DN', path: ['SEL_LDAP_CLIENT', 'General Settings', 'BIND_DN'] },
          { id: 'bindPassword', label: 'Bind Password', path: ['SEL_LDAP_CLIENT', 'General Settings', 'BIND_DN_PASSWORD'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_LDAPServer',
        label: 'LDAP Servers',
        base: ['SEL_LDAP_CLIENT', 'LDAP Servers', 'LDAP Server'],
        columns: [
          { id: 'hostname', label: 'Hostname', key: ['LDAP_SR'] },
          { id: 'port', label: 'Port', key: ['LDAP_PT'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_LDAPGroup',
        label: 'LDAP Group Maps',
        base: ['SEL_LDAP_CLIENT', 'LDAP Group Maps', 'LDAP Group Map'],
        columns: [
          { id: 'groupMapRole', label: 'Group Map Role', key: ['MAP_ROLE'] },
          { id: 'groupMapDn', label: 'Group Map DN', key: ['MAP_DN'] },
        ],
      },
      {
        kind: 'fields',
        id: 'tbl_RADIUSGeneral',
        label: 'RADIUS General',
        fields: [
          { id: 'enabled', label: 'Enabled', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_ENABLE_ST'] },
          { id: 'enableAnonymousId', label: 'Enable Anonymous ID', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_ANONYMOUS_ID_ENABLE_ST'] },
          { id: 'anonymousId', label: 'Anonymous ID', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_ANONYMOUS_ID_ST'] },
          { id: 'sharedSecret', label: 'Shared Secret', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_SHARED_SECRET_ST'] },
          { id: 'authProtocol', label: 'Auth Protocol', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_AUTHENTICATION_PROTOCOL_ST'] },
          { id: 'retryAmount', label: 'Retry Amount', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_RETRIES_ST'] },
          { id: 'retryTimeout', label: 'Retry Timeout', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_TIMEOUT_ST'] },
          { id: 'checkServerCertHostname', label: 'Check Server Cert Hostname', path: ['SEL_RADIUS_Client', 'General Settings', 'RADIUS_CHECK_SERVER_CERT_HOSTNAME_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_RADIUSServer',
        label: 'RADIUS Servers',
        base: ['SEL_RADIUS_Client', 'RADIUS Servers', 'RADIUS Server'],
        columns: [
          { id: 'priority', label: 'Priority', key: ['RADIUS_SERVER_ID_ST'] },
          { id: 'hostname', label: 'Hostname', key: ['RADIUS_SERVER_NAME_ST'] },
          { id: 'port', label: 'Port', key: ['RADIUS_SERVER_AUTH_PORT_ST'] },
        ],
      },
    ],
  };

  const security = {
    id: 'security',
    label: 'Security',
    tables: [
      {
        kind: 'fields',
        id: 'tbl_X509Active',
        label: 'X.509 Active Certificate',
        fields: [
          { id: 'activeCert', label: 'Active Cert', path: ['x509', 'x509 global', 'X509_ACTIVECERT_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_X509Cert',
        label: 'X.509 Certificates',
        base: ['x509', 'certificates', 'certificate'],
        columns: [
          { id: 'certName', label: 'Cert Name', key: ['X509_NAME_ST'] },
          { id: 'cert', label: 'Cert', key: ['X509_CERT_ST'] },
          { id: 'certPrivateKey', label: 'Cert Private Key', key: ['X509_PRIVKEY_ST'] },
        ],
      },
      {
        kind: 'list',
        id: 'tbl_MACSec',
        label: 'MAC-Based Port Security',
        base: ['mac_security', 'port'],
        columns: [
          { id: 'port', label: 'Port', key: ['port_id'] },
          { id: 'enable', label: 'Enable', key: ['PS_SECURITYMODE_ST'] },
          { id: 'countLock', label: 'Count Lock', key: ['PS_COUNTLOCK_ST'] },
          { id: 'timeLock', label: 'Time Lock', key: ['PS_TIMELOCK_ST'] },
          // The old tool joined ALL mac_addresses/mac_address entries into one
          // comma-separated cell and split it back on write (also mirroring
          // the first MAC to the port-level PS_MACADDRESS_ST leaf). This
          // schema shape can only address a single leaf, so the column shows
          // the first MAC and is readOnly; multi-MAC editing needs dedicated
          // service support.
          { id: 'macs', label: 'MACs', key: ['mac_addresses', 'mac_address', 0, 'PS_MACADDRESS_ST'], readOnly: true },
        ],
      },
    ],
  };

  return { sections: [system, switchManagement, network, accounts, security] };
}
