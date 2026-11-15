// DAC connectors: the link from this DAC to a neighbouring one, at a tie. Every
// CLECO scheme writes them the same way, in Init_DA_Connector:
//
//   Bunkie_Lecompte_Manager.Init(RemoteDacName := 'Lecompte', DeviceDefinition := DA_Manager);
//   Bunkie_Lecompte_Manager.InitBackplane(Port := 59007, LocalIps := Bunkie_IPs, RemoteIps := Lecompte_IPs);
//   Bunkie_Lecompte_Manager.InitDaScadaLink(pFirst_Bi := ADR(DMS_MAP_DNP.Bunkie_Lecompte_BI_00000_CommFail), …);
//   F5905A_Conn.Init(Name := '6319C_5905A', DeviceDefinition := DA_Connector, Manager := Bunkie_Lecompte_Manager);
//   F5905A_Conn.InitDaScadaLink(pFirst_Bi := ADR(DMS_MAP_DNP.F5905A_Conn_BI_00000_Abnormal), …);
//
// One manager per remote DAC (its port and IP variables must match the remote
// DAC's own), any number of connectors on it. A connector's Name is the key
// both DACs share: C<recloser> on 34.5kV, the two feeders on 13.2kV. On the
// AreaMap a connector is a DA_DAC_INTERCONNECT.Bo box feeding the tie.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readImplementation } from './pou.js';

const lower = (s) => String(s ?? '').toLowerCase();
const text = (v) => String(v ?? '').trim();
const strip = (t) => t.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/[^\n]*/g, '');

/** "Name := value" pairs of a call's argument text, keys lowercased. */
function args(body) {
  const out = {};
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*:=\s*('[^']*'|[^,]+?)\s*(?=,|$)/g)) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

/** The managers, connectors and IP variables a project's connector POU holds. */
async function readInterconnect(rtacDir, pouName) {
  const out = { managers: [], connectors: [], ipVars: new Map(), dacName: null };
  const area = await readFile(path.join(rtacDir, 'SEL_RTAC', 'DAC', 'AreaControl.xml'), 'utf8').catch(() => '');
  out.dacName = /\bName\s*:=\s*'([^']+)'/.exec(strip(area))?.[1] ?? null;
  if (!pouName) return out;
  const xml = await readFile(path.join(rtacDir, 'SEL_RTAC', 'DAC', 'Initializations', pouName), 'utf8');
  const iface = /<Interface><!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml)?.[1] ?? '';
  for (const m of strip(iface).matchAll(/^\s*(\w+)\s*:\s*ARRAY\s*\[[^\]]*\]\s*OF\s*IpAdrStr\s*:=\s*\[\s*'([^']*)'/gim)) {
    out.ipVars.set(lower(m[1]), { name: m[1], ip: m[2] });
  }
  const managers = new Map();
  const impl = strip(readImplementation(xml));
  for (const m of impl.matchAll(/(\w+)\s*\.\s*(Init\w*)\s*\(([\s\S]*?)\)\s*;/gi)) {
    const [, inst, method, body] = m;
    const a = args(body.replace(/\s+/g, ' '));
    const key = lower(inst);
    const mgr = managers.get(key) ?? { name: inst };
    if (/^init$/i.test(method) && a.remotedacname) {
      Object.assign(mgr, { remote: a.remotedacname.replace(/'/g, ''), definition: a.devicedefinition });
      managers.set(key, mgr);
    } else if (/^initbackplane$/i.test(method)) {
      Object.assign(mgr, { port: Number(a.port), localIps: a.localips, remoteIps: a.remoteips });
      managers.set(key, mgr);
    } else if (/^initdascadalink$/i.test(method) && managers.has(key)) {
      mgr.scada = /\(\s*(\w+)\.(\w+?)_?BI_00000_/i.exec(a.pfirst_bi ?? '')?.slice(1, 3) ?? null;
    } else if (/^init$/i.test(method) && a.manager) {
      out.connectors.push({ name: inst, connection: (a.name ?? '').replace(/'/g, ''), definition: a.devicedefinition, manager: a.manager });
    }
  }
  out.managers = [...managers.values()].filter((m) => m.remote);
  return out;
}

const numberOf = (name) => /(\d+[A-Za-z]?)/.exec(String(name ?? ''))?.[1] ?? null;

/** The identifier a connector row produces. */
function connectorName(row) {
  const given = text(row.name);
  if (given) return given;
  const n = numberOf(row.feeds);
  return n ? `R${n}_Connector` : null;
}

/**
 * Plan each connector row: its identifier, shared Name, manager (an existing
 * one by remote DAC, or a new one), and the IP variables a new manager needs.
 * Pure: the SCADA step and the init step both ask.
 */
function planConnectors(rows, project, family) {
  const ic = project.interconnect ?? { managers: [], connectors: [], ipVars: new Map(), dacName: null };
  const warnings = [];
  const warn = (device, message) => warnings.push({ device, message });
  const plans = [];
  const fresh = new Map(); // remote -> new manager planned this run
  const local = ic.managers[0]?.localIps ?? (ic.dacName ? `${ic.dacName.replace(/\s+/g, '_')}_IPs` : null);
  const localBase = local ? local.replace(/_IPs$/i, '') : (ic.dacName ?? 'DAC').replace(/\s+/g, '_');
  // Map groups go by the instance name, or by it without "_Manager", as the
  // project's own managers do.
  const stripsSuffix = ic.managers.some((m) => m.scada && lower(m.scada[1]) === lower(m.name.replace(/_Manager$/i, '')));
  const ports = ic.managers.map((m) => m.port).filter(Number.isFinite);

  for (const row of rows) {
    const name = connectorName(row);
    if (!name) { warn('Connector', 'give the connector a name or the tie it feeds'); continue; }
    const remote = text(row.remoteDac);
    let manager = null;
    if (remote) {
      manager = ic.managers.find((m) => lower(m.remote) === lower(remote))
        ?? ic.managers.find((m) => lower(m.name).includes(lower(remote.replace(/\s+/g, '_'))))
        ?? fresh.get(lower(remote)) ?? null;
    } else if (ic.managers.length === 1) {
      manager = ic.managers[0];
    }
    if (!manager && !remote) {
      warn(name, ic.managers.length ? `give the remote DAC (${ic.managers.map((m) => m.remote).join(', ')})` : 'give the remote DAC');
      continue;
    }
    if (!manager) {
      const remoteBase = remote.replace(/\s+/g, '_');
      const mgrName = `${localBase}_${remoteBase}_Manager`;
      const port = Number(text(row.port)) || (ports.length ? Math.max(...ports) + 1 : 59001);
      if (!text(row.port)) warn(name, `new manager ${mgrName}: port ${port} guessed; it must match ${remote}'s`);
      ports.push(port);
      const remoteVar = ic.ipVars.get(lower(`${remoteBase}_IPs`))?.name ?? `${remoteBase}_IPs`;
      const vars = [];
      if (!ic.ipVars.has(lower(remoteVar)) && !plans.some((p) => p.vars?.some((v) => lower(v.name) === lower(remoteVar)))) {
        const ip = text(row.remoteIp);
        if (!ip) warn(name, `${remoteVar}: no remote IP given; wrote 0.0.0.0`);
        vars.push({ name: remoteVar, ip: ip || '0.0.0.0' });
      }
      const localVar = local ?? `${localBase}_IPs`;
      if (!ic.ipVars.has(lower(localVar)) && !plans.some((p) => p.vars?.some((v) => lower(v.name) === lower(localVar)))) {
        warn(name, `${localVar}: this DAC's IP isn't set; wrote 0.0.0.0`);
        vars.push({ name: localVar, ip: '0.0.0.0' });
      }
      manager = {
        name: mgrName, remote, port, localIps: localVar, remoteIps: remoteVar, isNew: true, vars,
        group: stripsSuffix ? mgrName.replace(/_Manager$/i, '') : mgrName,
      };
      fresh.set(lower(remote), manager);
    }
    let connection = text(row.connection);
    if (!connection) {
      const n = numberOf(row.feeds) ?? numberOf(name);
      connection = `C${n}`;
      if (family !== '34.5kV') warn(name, `Name ${connection} guessed; it must match the connector on ${manager.remote}`);
    }
    // A new manager is written (and its IP variables added) with the first
    // connector on it.
    const first = !!manager.isNew && !plans.some((p) => p.manager === manager);
    plans.push({ name, connection, manager, feeds: text(row.feeds), newManager: first, vars: first ? manager.vars : [] });
  }
  return { plans, warnings };
}

// --- text --------------------------------------------------------------------

function managerBlock(m, def, scada) {
  return [
    `${m.name}.Init(`,
    `\tRemoteDacName\t\t:=\t'${m.remote}', // RemoteDacName variable must match 'DA_CONTROLLER.Name' variable in the 'AreaControl' program of the REMOTE DAC`,
    `\tDeviceDefinition\t:=\t${def});`,
    `${m.name}.InitBackplane(`,
    `\tPort\t\t:=\t${m.port}, // IP Port to use for communications. Port must be IDENTICAL on both local and remote DAC. Must not share a port with redundancy.`,
    `\tLocalIps\t:=\t${m.localIps},`,
    `\tRemoteIps\t:=\t${m.remoteIps});`,
    `${m.name}.InitDaScadaLink(`,
    `\tpFirst_Bi\t:=\t${scada ?? '0'},`,
    '\tpFirst_Ai\t:=\t0,',
    '\tpFirst_Bo\t:=\t0,',
    '\tpFirst_Ao\t:=\t0,',
    '\tpFirst_Cnt\t:=\t0);',
  ].join('\n');
}

/** A connector's init (with its new manager's ahead of it, if it brings one). */
function connectorBlock(spec) {
  const lines = [];
  if (spec.newManager) lines.push(managerBlock(spec.manager, spec.managerDefinition, spec.managerScada), '');
  lines.push(
    `${spec.name}.Init(`,
    `\tName\t\t\t\t:=\t'${spec.connection}', // Connector 'Name' must be IDENTICAL on both local and remote DAC`,
    `\tDeviceDefinition\t:=\t${spec.definition},`,
    `\tManager\t\t\t\t:=\t${spec.manager.name});`,
    `${spec.name}.InitDaScadaLink(`,
    `\tpFirst_Bi\t:=\t${spec.scada ?? '0'},`,
    '\tpFirst_Ai\t:=\t0,',
    '\tpFirst_Bo\t:=\t0,',
    '\tpFirst_Ao\t:=\t0,',
    '\tpFirst_Cnt\t:=\t0);',
  );
  return lines.join('\n');
}

/** Add IP variables to a POU's VAR block, before its END_VAR. */
function addIpVars(xml, vars) {
  if (!vars.length) return xml;
  const m = /(<Interface><!\[CDATA\[)([\s\S]*?)(\]\]>)/.exec(xml);
  if (!m) return xml;
  const body = m[2];
  const at = body.lastIndexOf('END_VAR');
  if (at < 0) return xml;
  const lines = vars.map((v) => `\t${v.name} : ARRAY[1..1] OF IpAdrStr := ['${v.ip}'];`).join('\n');
  const before = body.slice(0, at).replace(/\s*$/, '');
  const next = `${before}\n${lines}\n${body.slice(at)}`;
  return xml.slice(0, m.index) + m[1] + next + m[3] + xml.slice(m.index + m[0].length);
}

/** A new, empty Init_DA_Connector POU made from another Init_* POU's file. */
function newConnectorPou(siblingXml, name) {
  return siblingXml
    .replace(/<Name>[^<]*<\/Name>/, `<Name>${name}</Name>`)
    .replace(/<Interface><!\[CDATA\[[\s\S]*?\]\]><\/Interface>/, `<Interface><![CDATA[PROGRAM ${name}\nVAR\nEND_VAR\n]]></Interface>`)
    .replace(/<Implementation><!\[CDATA\[[\s\S]*?\]\]><\/Implementation>/, '<Implementation><![CDATA[]]></Implementation>');
}

export { readInterconnect, planConnectors, connectorName, connectorBlock, addIpVars, newConnectorPou };
