// SEL terminal service: round-trip against a fake relay, refusal paths, and
// stream-detach teardown — ported from Volture's terminal tests.

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { SelTerminalService, cleanInbound } from '../services/tools/selTerminal.js';

// A fake relay: answers ACC with a password prompt, anything else with '='.
function startFakeRelay() {
  const server = net.createServer((socket) => {
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      let at;
      while ((at = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, at).trim();
        pending = pending.slice(at + 2);
        if (line === 'ACC') socket.write('Password: ?');
        else socket.write(`${line}\r\n=`);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// Collect stream output until `match` appears (or time runs out).
function collectUntil(service, sessionId, match) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${match}; got: ${text}`)), 2000);
    const unsubscribe = service.subscribe(sessionId, {
      data: (chunk) => {
        text += chunk;
        if (text.includes(match)) {
          clearTimeout(timer);
          resolve({ text, unsubscribe });
        }
      },
      closed: (reason) => {
        clearTimeout(timer);
        reject(new Error(`closed early: ${reason}`));
      },
    });
  });
}

test('terminal: session round-trips input and output', async () => {
  const relay = await startFakeRelay();
  const service = new SelTerminalService();
  try {
    const { sessionId } = await service.open({ host: '127.0.0.1', port: relay.port, transport: 'tcp' });

    // The open nudge ('\r\n') produces the first prompt — buffered as backlog
    // until the stream attaches, then flushed.
    const first = await collectUntil(service, sessionId, '=');
    assert.ok(first.text.includes('='));

    let closedReason = null;
    let text = '';
    first.unsubscribe(); // Detach closes the session...
    assert.rejects(async () => service.input(sessionId, 'x'), /no such terminal session/);

    // ...so open a fresh one for the command round-trip, subscriber first.
    const second = await service.open({ host: '127.0.0.1', port: relay.port, transport: 'tcp' });
    const got = new Promise((resolve) => {
      service.subscribe(second.sessionId, {
        data: (chunk) => {
          text += chunk;
          if (text.includes('Password:')) resolve();
        },
        closed: (reason) => {
          closedReason = reason;
        },
      });
    });
    service.input(second.sessionId, 'ACC\r\n');
    await got;
    assert.ok(text.includes('Password: ?'));

    service.close(second.sessionId);
    assert.equal(closedReason, 'Closed by user');

    // The tombstone answers a late stream with the reason, not a 404.
    let lateReason = null;
    service.subscribe(second.sessionId, { data: () => {}, closed: (reason) => { lateReason = reason; } });
    assert.equal(lateReason, 'Closed by user');
  } finally {
    service.closeAll();
    await relay.close();
  }
});

test('terminal: refusal paths', async () => {
  const service = new SelTerminalService();
  assert.throws(() => service.open({ host: '' }), /host required/);
  assert.throws(() => service.open({ host: 'x', port: 0 }), /invalid port/);
  assert.throws(() => service.open({ host: 'x', transport: 'serial' }), /transport must be/);
  assert.throws(() => service.subscribe('term-9', { data: () => {}, closed: () => {} }), /no such/);
  // A connect to a dead port surfaces as a coded 502, not an open session.
  await assert.rejects(
    () => service.open({ host: '127.0.0.1', port: 1, transport: 'tcp', timeoutMs: 1500 }),
    /terminal connect failed/,
  );
});

test('terminal: telnet negotiation and framing bytes are stripped', () => {
  const bytes = Buffer.from([
    0xff, 0xfb, 0x01,       // IAC WILL ECHO — dropped
    0x48, 0x69,             // "Hi"
    0xff, 0xff,             // escaped 0xFF — one literal byte
    0x02, 0x11,             // STX, XON — dropped
    0xff, 0xfa, 0x18, 0x00, 0xff, 0xf0, // subnegotiation — dropped
    0x3d,                   // "="
  ]);
  assert.equal(cleanInbound(bytes, { telnet: true }), 'Hiÿ=');
  // Raw tcp mode keeps 0xFF sequences as data (only flow-control stripped).
  assert.equal(cleanInbound(Buffer.from([0xff, 0xfb, 0x01, 0x41]), { telnet: false }), 'ÿûA');
});
