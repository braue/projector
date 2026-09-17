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
import { execFile, spawn } from 'node:child_process';
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

// Lab defaults, written to open a session and nothing else.
//
// Every prompt mstsc can raise is a click this tool exists to remove, and an
// unsigned .rdp raises the worst of them: the "do you trust this connection"
// dialog listing the local resources the file asks to redirect — clipboard,
// printers, Windows Hello, smart cards. The file therefore asks for as little
// as it can. Clipboard stays (it is the one redirection anybody wants from a
// lab box); everything else is turned OFF EXPLICITLY rather than left to its
// default, because the default for several of them is on and each one adds a
// line to that dialog.
//
// authentication level:i:0 is "connect and don't warn me", which covers the
// other prompt: a simulator VM's self-signed certificate is not news.
function rdpFile({ address, username }) {
  return [
    `full address:s:${address}`,
    username ? `username:s:${username}` : null,
    `prompt for credentials:i:${username ? 0 : 1}`,
    'authentication level:i:0',
    'enablecredsspsupport:i:1',
    'screen mode id:i:2',
    'use multimon:i:0',
    'dynamic resolution:i:1',
    // The one redirection worth having.
    'redirectclipboard:i:1',
    // Everything the consent dialog would otherwise enumerate.
    'redirectprinters:i:0',
    'redirectcomports:i:0',
    'redirectsmartcards:i:0',
    'redirectwebauthn:i:0',
    'redirectlocation:i:0',
    'drivestoredirect:s:',
    'devicestoredirect:s:',
    'usbdevicestoredirect:s:',
    'camerastoredirect:s:',
    'audiocapturemode:i:0',
    'audiomode:i:0',
    '',
  ].filter((line) => line !== null).join('\r\n');
}

/** Run a console command to completion, resolving its exit code (never
 *  rejecting on a nonzero exit — the caller decides what a failure means).
 *  windowsHide keeps cmdkey from flashing a console window. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => resolve({ code: null, error: err }));
    child.on('close', (code) => resolve({ code, error: null }));
  });
}

// Where mstsc records "don't ask me again for connections to this computer" —
// the checkbox on the consent dialog an unsigned .rdp raises. Writing the
// entry before the client starts answers that dialog in advance, per host.
//
// The value is a bitmask of the resource classes consented to; Microsoft
// documents neither the bits nor the key, so 0xFF covers every class and
// leaves nothing the file might ask for outside it.
const LOCAL_DEVICES_KEY = 'HKCU\\Software\\Microsoft\\Terminal Server Client\\LocalDevices';
const LOCAL_DEVICES_ALL = '0xFF';

/** Pre-answer the consent dialog for each address form. Best effort: where
 *  reg.exe is locked down the session still opens, it just asks once and
 *  remembers the answer itself. */
async function preconsent(keys) {
  for (const key of keys) {
    await run('reg', [
      'add', LOCAL_DEVICES_KEY, '/v', key, '/t', 'REG_DWORD', '/d', LOCAL_DEVICES_ALL, '/f',
    ]);
  }
}

// How long a launched client gets to prove it stayed up. A real session runs
// longer than this; anything that exits inside it never connected.
const SETTLE_MS = 2500;

/**
 * Start a Windows GUI program the way the shell starts it, via PowerShell's
 * Start-Process.
 *
 * This is the one launch that has been WATCHED WORKING on the machine this
 * tool is for: the same client, the same connection file, started this way,
 * held a session for as long as it was wanted, while a direct spawn of it put
 * up a window that went away. Start-Process goes through ShellExecute instead
 * of CreateProcess, so the client is launched on the shell's behalf — it
 * inherits none of this process's handles or startup flags, and owns its own
 * foreground activation.
 *
 * windowsHide here applies to the PowerShell console only. The client is
 * created separately by ShellExecute with its own startup info, so the flag
 * cannot reach it.
 *
 * Returns the launched process id (-PassThru), so the caller can tell whether
 * it stayed up without owning it.
 */
function shellExecute(program, programArgs) {
  // PowerShell single-quoted strings escape a quote by doubling it. Windows
  // paths cannot contain a double quote, so wrapping each argument in one is
  // safe and keeps spaces intact for the program being started.
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const argList = programArgs.map((arg) => `"${arg}"`).join(' ');
  const command = `$p = Start-Process -FilePath ${quote(program)}`
    + `${programArgs.length ? ` -ArgumentList ${quote(argList)}` : ''} -PassThru; if ($p) { $p.Id }`;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        const pid = Number(String(stdout).trim().split(/\s+/)[0]);
        resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
      },
    );
  });
}

/** Is that process still there? EPERM means yes, just not ours to signal. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Give a launched client its settle window, then say whether it is still up. */
async function settled(pid) {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return alive(pid);
}

/**
 * Spawn a GUI client directly and watch the first few seconds of its life.
 *
 * The FreeRDP path only — Windows goes through shellExecute() above, because
 * a direct spawn of mstsc there produced a window that opened and went while
 * the very same file, started by the shell, held a session indefinitely.
 *
 * The window outlives this request, so the launch is still fire-and-forget —
 * but a client that appears and vanishes never connected at all, and its exit
 * code is the only account of why. Resolving with a null exitCode means it was
 * still running when we let go of it.
 *
 * No windowsHide on a GUI client: libuv turns it into STARTF_USESHOWWINDOW
 * with SW_HIDE, a show-command Windows hands to the program's own main window.
 */
function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.unref(); // still alive — let the session have it
      settle({ exitCode: null });
    }, SETTLE_MS);
    // Never hold the event loop open on this timer.
    timer.unref?.();
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => settle({ exitCode: code ?? null }));
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

    // Answer the redirection-consent dialog before it can be asked, for
    // whichever address form mstsc keys it on.
    await preconsent([address, withoutPort(address)].filter(Boolean));

    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${vm.id}.rdp`);
    await writeFile(file, rdpFile({ address, username }), 'utf8');

    const mstsc = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');

    let pid = null;
    try {
      pid = await shellExecute(mstsc, [file]);
    } catch (err) {
      throw httpError(500, `could not start the Remote Desktop client: ${err?.message ?? err}`);
    }

    // A session that lasts less than SETTLE_MS is not a session. The client is
    // the shell's now, not ours, so ask after it by pid rather than owning it.
    if (pid && !(await settled(pid))) {
      throw httpError(500,
        'the Remote Desktop client exited immediately. Its connection file is '
        + `${file} — open that by hand to see the client's own error.`);
    }

    return { launched: vm.id, client: 'mstsc', address, file, pid, note: null };
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
        const { exitCode } = await launch(client, args);
        if (exitCode) {
          throw httpError(500, `${client} exited immediately (code ${exitCode}).`);
        }
        return { launched: vm.id, client, address, file: null, note: null };
      } catch (err) {
        if (err?.status) throw err;
        if (err?.code !== 'ENOENT') throw httpError(500, `could not launch ${client}: ${err.message}`);
      }
    }
    throw httpError(501, 'no RDP client found — install FreeRDP (xfreerdp) to connect from this platform, or run the Windows build.');
  }
}

export { VmsService, rdpFile, withoutPort };
