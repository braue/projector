// The setting names an RTAC export uses to describe a connection's far end —
// address, port, serial line, and protocol addressing. Every consumer
// (parser layer 2, the comm extractor) reads them from here so a new spelling
// is added exactly once.

/** The far end's address (a client dials it, a broadcast is sent to it). */
const RTAC_REMOTE_ADDRESS_SETTINGS = ['Server IP Address', 'Broadcast Address'];

/** The port at that far end. */
const RTAC_REMOTE_PORT_SETTINGS = ['Server IP Port', 'Broadcast Port'];

/** The port the RTU itself uses, when the project pins one. */
const RTAC_LOCAL_PORT_SETTINGS = ['Client IP Port', 'Local Port Number'];

/** A serial link names only the RTU's own port — the far end has no address. */
const RTAC_SERIAL_PORT_SETTING = 'Serial Communications Port';
const RTAC_BAUD_SETTING = 'Baud Rate';

/** Serial framing, alongside port + baud. */
const RTAC_DATA_BITS_SETTING = 'Data Bits';
const RTAC_PARITY_SETTING = 'Parity Bit';
const RTAC_STOP_BITS_SETTING = 'Stop Bit';

/** DNP addresses as a connection states them (owners swap on server roles). */
const RTAC_DNP_CLIENT_ADDRESS_SETTING = 'Client DNP Address';
const RTAC_DNP_SERVER_ADDRESS_SETTING = 'Server DNP Address';

/** Modbus unit id. */
const RTAC_MODBUS_UNIT_SETTING = 'Slave ID';

export {
  RTAC_REMOTE_ADDRESS_SETTINGS,
  RTAC_REMOTE_PORT_SETTINGS,
  RTAC_LOCAL_PORT_SETTINGS,
  RTAC_SERIAL_PORT_SETTING,
  RTAC_BAUD_SETTING,
  RTAC_DATA_BITS_SETTING,
  RTAC_PARITY_SETTING,
  RTAC_STOP_BITS_SETTING,
  RTAC_DNP_CLIENT_ADDRESS_SETTING,
  RTAC_DNP_SERVER_ADDRESS_SETTING,
  RTAC_MODBUS_UNIT_SETTING,
};
