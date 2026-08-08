// The setting names an RTAC export uses to say where a connection goes. The
// parser folds them into one `endpoint` line per connection.

/** The far end's address (a client dials it, a broadcast is sent to it). */
const RTAC_REMOTE_ADDRESS_SETTINGS = ['Server IP Address', 'Broadcast Address'];

/** The port at that far end. */
const RTAC_REMOTE_PORT_SETTINGS = ['Server IP Port', 'Broadcast Port'];

/** The port the RTU itself uses, when the project pins one. */
const RTAC_LOCAL_PORT_SETTINGS = ['Client IP Port', 'Local Port Number'];

/** A serial link names only the RTU's own port — the far end has no address. */
const RTAC_SERIAL_PORT_SETTING = 'Serial Communications Port';
const RTAC_BAUD_SETTING = 'Baud Rate';

export {
  RTAC_REMOTE_ADDRESS_SETTINGS,
  RTAC_REMOTE_PORT_SETTINGS,
  RTAC_LOCAL_PORT_SETTINGS,
  RTAC_SERIAL_PORT_SETTING,
  RTAC_BAUD_SETTING,
};
