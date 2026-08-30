// SEL ASCII terminal — interactive sessions to a relay, ported from Volture's
// terminalManager. A terminal is a raw byte pipe: the browser sends lines,
// the relay's stream (echo, prompts, reports) flows back verbatim — so the
// relay's own no-echo handling keeps passwords off the screen, and the
// backend never sees or stores a relay password.
//
// Transport to the relay is plain TCP (node:net): port 23 telnet (IAC
// negotiation stripped) or a raw socket for serial-to-Ethernet converters.
// Toward the UI the Socket.IO events became a subscriber callback pair the
// SSE route bridges: output is buffered until the stream attaches (the
// prompt nudged right after connect must not be lost), and a session whose
// stream goes away is torn down — same as Volture on socket disconnect.

import net from 'node:net';

import { httpError } from '../../lib/http.js';

const IAC = 255;
const XON = 0x11;
const XOFF = 0x13;
const STX = 0x02;
const ETX = 0x03;

/** Strip telnet IAC negotiation sequences and flow-control bytes. STX/ETX
 *  frame relay output blocks; left in place they sit between the prompt and
 *  end-of-buffer and break prompt display. Everything is latin1, never
 *  UTF-8 — SEL relays emit 8-bit ASCII. */
function cleanInbound(buffer, { telnet }) {
  const out = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (telnet && byte === IAC) {
      const command = buffer[i + 1];
      if (command === IAC) {
        out.push(IAC); // Escaped 0xFF data byte.
        i += 1;
      } else if (command >= 251 && command <= 254) {
        i += 2; // WILL/WONT/DO/DONT <option>
      } else if (command === 250) {
        // Subnegotiation: skip through IAC SE.
        let j = i + 2;
        while (j < buffer.length && !(buffer[j] === IAC && buffer[j + 1] === 240)) j += 1;
        i = j + 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (byte === XON || byte === XOFF || byte === STX || byte === ETX || byte === 0) continue;
    out.push(byte);
  }
  return Buffer.from(out).toString('latin1');
}

const MAX_SESSIONS = 4;
const DEFAULT_PORT = 23;
const DEFAULT_TIMEOUT_MS = 10_000;
// Volture had no idle timeout (sessions lived as long as the browser); a
// desktop window can sit open for days, so an untouched relay session is
// closed rather than held forever.
const IDLE_TIMEOUT_MS = 30 * 60_000;
// Sessions that ended recently, so a stream arriving just after the close
// gets the reason instead of a bare 404.
const MAX_TOMBSTONES = 20;

class SelTerminalService {
  #sessions = new Map();
  #tombstones = new Map();
  #nextId = 1;

  /** Open a TCP session to the relay; resolves with the id once connected. */
  open({ host, port, transport, timeoutMs } = {}) {
    const targetHost = String(host ?? '').trim();
    if (!targetHost) throw httpError(400, 'host required');
    const targetPort = Number(port ?? DEFAULT_PORT);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw httpError(400, `invalid port: ${port}`);
    }
    const mode = transport ?? 'telnet';
    if (mode !== 'telnet' && mode !== 'tcp') {
      throw httpError(400, `transport must be telnet or tcp, not ${transport}`);
    }
    const connectMs = Math.min(Math.max(Number(timeoutMs ?? DEFAULT_TIMEOUT_MS), 1000), 120_000);
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw httpError(409, 'too many open terminal sessions — close one first');
    }

    const sessionId = `term-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const tcp = net.connect({ host: targetHost, port: targetPort });
      const session = {
        id: sessionId,
        tcp,
        telnet: mode === 'telnet',
        // Output before the SSE stream attaches (the prompt nudge's reply).
        backlog: [],
        subscriber: null,
        everSubscribed: false,
        idleTimer: null,
      };

      const connectTimer = setTimeout(() => {
        tcp.destroy(new Error('connect timeout'));
      }, connectMs);

      tcp.once('connect', () => {
        clearTimeout(connectTimer);
        this.#sessions.set(sessionId, session);
        this.#touch(session);
        resolve({ sessionId });
        // Nudge the relay so the user sees a prompt immediately.
        tcp.write('\r\n');
      });

      tcp.on('data', (chunk) => {
        if (!this.#sessions.has(sessionId)) return;
        const text = cleanInbound(chunk, { telnet: session.telnet });
        if (!text.length) return;
        this.#touch(session);
        if (session.subscriber) session.subscriber.data(text);
        else session.backlog.push(text);
      });

      tcp.on('error', (err) => {
        clearTimeout(connectTimer);
        if (this.#sessions.has(sessionId)) {
          this.#close(sessionId, err.message);
        } else {
          reject(httpError(502, `terminal connect failed: ${err.message}`));
        }
      });

      tcp.on('close', () => {
        clearTimeout(connectTimer);
        if (this.#sessions.has(sessionId)) {
          this.#close(sessionId, 'Relay closed the connection');
        }
      });
    });
  }

  /**
   * Attach the one output stream. Returns an unsubscribe function; when the
   * stream detaches, the session closes — its transcript lives in the
   * browser, so a session nobody is watching has nothing to reconnect to.
   * A recently-closed id gets its close reason instead of a 404.
   */
  subscribe(sessionId, { data, closed }) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      const reason = this.#tombstones.get(sessionId);
      if (reason !== undefined) {
        closed(reason);
        return () => {};
      }
      throw httpError(404, `no such terminal session: ${sessionId}`);
    }
    if (session.subscriber) throw httpError(409, 'session already has a stream attached');
    session.subscriber = { data, closed };
    session.everSubscribed = true;
    for (const text of session.backlog.splice(0)) data(text);
    return () => {
      if (session.subscriber?.data !== data) return;
      session.subscriber = null;
      if (this.#sessions.has(sessionId)) this.#close(sessionId, 'Client disconnected');
    };
  }

  /** Write user input (a line, or a control byte like CAN) to the relay. */
  input(sessionId, data) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw httpError(404, `no such terminal session: ${sessionId}`);
    const text = typeof data === 'string' ? data : '';
    if (!text) return;
    this.#touch(session);
    session.tcp.write(text, 'latin1');
  }

  close(sessionId, reason = 'Closed by user') {
    if (!this.#sessions.has(sessionId)) {
      throw httpError(404, `no such terminal session: ${sessionId}`);
    }
    this.#close(sessionId, reason);
  }

  closeAll() {
    for (const sessionId of [...this.#sessions.keys()]) {
      this.#close(sessionId, 'Service stopped');
    }
  }

  #close(sessionId, reason) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    clearTimeout(session.idleTimer);
    session.tcp.destroy();
    this.#tombstones.set(sessionId, reason);
    while (this.#tombstones.size > MAX_TOMBSTONES) {
      this.#tombstones.delete(this.#tombstones.keys().next().value);
    }
    session.subscriber?.closed(reason);
  }

  // Any traffic in either direction counts as activity. The timer must not
  // keep the process alive on its own — sessions die with it anyway.
  #touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.#close(session.id, 'Idle timeout'), IDLE_TIMEOUT_MS);
    session.idleTimer.unref?.();
  }
}

export { SelTerminalService, cleanInbound };
