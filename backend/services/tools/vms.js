// Virtual Machines — the lab boxes you RDP into, one card each, connected in
// one click.
//
// The store is a flat JSON list under the tools directory, and it DOES hold
// passwords in cleartext, by explicit choice: these are lab and simulator
// VMs, and the point of the tool is that a double-click lands you in a
// session without typing anything. (That is the opposite of the rule
// settings.json states for tool settings — noted here so the difference reads
// as a decision rather than an oversight.)
//
// Connecting is two steps on Windows, because mstsc will not take a password
// on its command line and never has:
//
//   1. the password goes into Windows Credential Manager under the key
//      mstsc looks up for this host, `TERMSRV/<address>`;
//   2. a generated .rdp file (no password field — it holds the address,
//      the user name, and the display/redirect preferences) is handed to
//      mstsc, which finds the credential and connects silently.
//
// The .rdp lives beside the store so it can be hand-edited when one VM needs
// something the form does not offer; it is rewritten from the card on every
// connect.

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';

// FreeRDP's two binary names — the dev fallback on this repo's Linux side.
const LINUX_CLIENTS = ['xfreerdp3', 'xfreerdp'];

function requireField(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

// One .rdp directive per line, so a newline in a field would forge directives
// (a "password 51:b:" line among them). Strip control characters from every
// value that reaches the file or a command line.
function stripControl(value) {
  return String(value ?? '').replace(/[\r\n\t\0]/g, '');
}

// Addresses and user names additionally lose their surrounding whitespace —
// a pasted "10.0.0.5 " is the same host. A PASSWORD never gets this: a
// trailing space in one is a character, not a typo, and trimming it would
// fail the logon for a reason nothing on screen could explain.
function clean(value) {
  return stripControl(value).trim();
}

/** The address without its port, or null when there is no port to drop. */
function withoutPort(address) {
  const match = /^(.*):(\d{1,5})$/.exec(address);
  return match ? match[1] : null;
}

// Lab defaults: full screen, clipboard and printers through, and no identity
// warning — a simulator VM's self-signed certificate is not news, and the
// prompt is exactly the click this tool exists to remove.
function rdpFile({ address, username }) {
  return [
    `full address:s:${address}`,
    username ? `username:s:${username}` : null,
    `prompt for credentials:i:${username ? 0 : 1}`,
    'authentication level:i:0',
    'screen mode id:i:2',
    'use multimon:i:0',
    'dynamic resolution:i:1',
    'redirectclipboard:i:1',
    'redirectprinters:i:1',
    'audiomode:i:0',
    '',
  ].filter((line) => line !== null).join('\r\n');
}

/** Run a command to completion, resolving its exit code (never rejecting on
 *  a nonzero exit — the caller decides what a failure means). */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => resolve({ code: null, error: err }));
    child.on('close', (code) => resolve({ code, error: null }));
  });
}

/** Launch and forget: the RDP window outlives this request. */
function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    // 'spawn' fires once the process is actually running; nothing after that
    // is this request's business.
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

class VmsService {
  constructor({ dataDir }) {
    this.dir = path.join(dataDir, 'tools', 'vms');
    this.file = path.join(this.dir, 'vms.json');
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(parsed?.vms) ? parsed.vms : [];
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  async #write(vms) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, JSON.stringify({ vms }, null, 2));
  }

  /** Every card, in the order they were added. */
  async list() {
    return { vms: await this.#read() };
  }

  /**
   * Create (no `id`) or update (an `id` that exists) one card.
   * payload: { id?, name, host, username, password, notes }
   */
  async save(payload) {
    const vms = await this.#read();
    const card = {
      name: requireField(payload?.name, 'name'),
      // "host" is whatever mstsc should dial — an IP, a name, either with an
      // optional :port. Kept verbatim: it is also the credential's key.
      host: clean(requireField(payload?.host, 'address')),
      username: clean(payload?.username),
      password: String(payload?.password ?? ''),
      notes: clean(payload?.notes),
    };

    const id = clean(payload?.id);
    if (id) {
      const at = vms.findIndex((vm) => vm.id === id);
      if (at === -1) throw httpError(404, `no such VM: ${id}`);
      vms[at] = { ...vms[at], ...card };
      await this.#write(vms);
      return vms[at];
    }

    const created = { id: randomBytes(4).toString('hex'), ...card };
    vms.push(created);
    await this.#write(vms);
    return created;
  }

  async remove(id) {
    const vms = await this.#read();
    const next = vms.filter((vm) => vm.id !== id);
    if (next.length === vms.length) throw httpError(404, `no such VM: ${id}`);
    await this.#write(next);
    return { removed: id };
  }

  async #find(id) {
    const vm = (await this.#read()).find((entry) => entry.id === id);
    if (!vm) throw httpError(404, `no such VM: ${id}`);
    return vm;
  }

  /** Open an RDP session on one card. Returns which client was launched. */
  async connect(id) {
    const vm = await this.#find(id);
    return process.platform === 'win32' ? this.#connectWindows(vm) : this.#connectFreeRdp(vm);
  }

  async #connectWindows(vm) {
    const address = clean(vm.host);
    const username = clean(vm.username);
    const password = stripControl(vm.password);

    if (username && password) {
      // mstsc looks the credential up by the address string it dials. A card
      // written with a port ("10.0.0.5:3390") is dialed with the port but has
      // been seen to look up without it, so both keys get written — a stale
      // extra generic credential costs nothing and a missed one costs the
      // prompt this tool exists to remove.
      const keys = [address, withoutPort(address)].filter(Boolean);
      for (const key of keys) {
        const stored = await run('cmdkey', [
          `/generic:TERMSRV/${key}`,
          `/user:${username}`,
          `/pass:${password}`,
        ]);
        // Only a MISSING cmdkey is fatal here. A nonzero exit (a key Windows
        // would not take) leaves the credential unsaved, and mstsc then asks
        // for it — a visible, recoverable outcome, better than refusing to
        // open the session at all.
        if (stored.error) {
          throw httpError(500, `could not store the credential for ${vm.name}: ${stored.error.message}`);
        }
      }
    }

    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${vm.id}.rdp`);
    await writeFile(file, rdpFile({ address, username }), 'utf8');

    try {
      await launch('mstsc', [file]);
    } catch (err) {
      throw httpError(500, err?.code === 'ENOENT'
        ? 'mstsc was not found — the Remote Desktop client ships with Windows; is this a Windows install?'
        : `could not launch mstsc: ${err?.message ?? err}`);
    }
    return { launched: vm.id, client: 'mstsc', address };
  }

  // Development fallback: this repo is written on Linux and mstsc is Windows
  // only, so the tool stays usable here through FreeRDP. Its password DOES go
  // on the command line (visible in `ps` while the session runs) — fine for
  // the lab VMs this tool addresses, and not the packaged app's path.
  async #connectFreeRdp(vm) {
    const address = clean(vm.host);
    const username = clean(vm.username);
    const password = stripControl(vm.password);
    const args = [
      `/v:${address}`,
      username ? `/u:${username}` : null,
      password ? `/p:${password}` : null,
      '/cert:ignore',
      '/dynamic-resolution',
      '+clipboard',
    ].filter(Boolean);

    for (const client of LINUX_CLIENTS) {
      try {
        await launch(client, args);
        return { launched: vm.id, client, address };
      } catch (err) {
        if (err?.code !== 'ENOENT') throw httpError(500, `could not launch ${client}: ${err.message}`);
      }
    }
    throw httpError(501, 'no RDP client found — install FreeRDP (xfreerdp) to connect from this platform, or run the Windows build.');
  }
}

export { VmsService, rdpFile, withoutPort };
