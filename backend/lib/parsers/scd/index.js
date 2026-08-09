// Parser for IEC 61850 SCL files — the .scd substation configurations tools
// like AcSELerator Architect produce (and, same schema at different scopes,
// .icd/.cid/.ssd device and instance files).
//
// Modeled on the proven Architect workbook extractor: each IED is read as the
// five comm truths an engineer actually audits —
//
//   Network        where it sits (subnetworks, access-point IP/subnet/gateway,
//                  and the multicast MAC/APPID/VLAN each publication uses)
//   Datasets       what it packages — every FCDA resolved to its 61850 path
//                  AND, when the file carries DOI/DAI address maps, the
//                  device-native source tag (sAddr / esel:datasrc) plus units
//   GOOSE TX       what it publishes (GSEControl merged with its wire address,
//                  SEL min/max retransmission times included)
//   GOOSE RX       what it consumes point-by-point (bound ExtRefs formatted
//                  as publisher control block -> data path, sorted by the
//                  subscriber's internal address)
//   Reports        client-facing ReportControl blocks with their full trigger
//                  and option field configuration
//
// Loss-tolerant like the RTAC parser: any section or attribute the schema
// allows to be absent simply yields null/empty, and unknown elements are
// ignored rather than fatal. SEL ICDs ship thousands of pre-provisioned
// UNBOUND ExtRefs (an intAddr slot with no publisher); those are tallied per
// logical device but only bound refs make the subscription list, so the
// model reflects configured links, not template capacity.

import { attr, parseXml, text, toArray } from '../xml.js';

// <P type="IP">1.2.3.4</P> siblings -> { IP: '1.2.3.4', ... }; first wins.
// Also reads the esel:P namespaced variant SEL privates use.
function pValues(container) {
  const out = {};
  for (const p of [...toArray(container?.P), ...toArray(container?.['esel:P'])]) {
    const type = attr(p, 'type');
    if (type && !(type in out)) out[type] = text(p);
  }
  return out;
}

// --- Communication section ---------------------------------------------------

// GSE / SMV blocks under a ConnectedAP: the wire address of one publication.
function parseWireAddress(node) {
  return {
    ldInst: attr(node, 'ldInst'),
    cbName: attr(node, 'cbName'),
    address: pValues(node.Address),
  };
}

function parseConnectedAp(ap) {
  return {
    iedName: attr(ap, 'iedName'),
    apName: attr(ap, 'apName'),
    desc: attr(ap, 'desc'),
    address: pValues(ap.Address),
    ports: toArray(ap.PhysConn).flatMap((conn) => Object.values(pValues(conn))),
    gses: toArray(ap.GSE).map(parseWireAddress),
    smvs: toArray(ap.SMV).map(parseWireAddress),
  };
}

function parseSubNetworks(communication) {
  return toArray(communication?.SubNetwork).map((subNetwork) => ({
    name: attr(subNetwork, 'name'),
    type: attr(subNetwork, 'type'),
    desc: attr(subNetwork, 'desc'),
    connectedAps: toArray(subNetwork.ConnectedAP).map(parseConnectedAp),
  }));
}

// --- FCDA -> device source resolution -----------------------------------------
//
// Architect exports embed each IED's full instantiated data model: DOI/SDI/DAI
// trees whose leaves carry sAddr (or esel:datasrc) — the device-native tag a
// 61850 point actually reads ("db:LOC" -> relay word bit LOC). Walking the
// FCDA's do/da path through that tree turns an opaque dataset entry into the
// signal an engineer can find in the relay's own settings.

// The IED's LN lookup: ldInst -> [{prefix, lnClass, inst, node}].
function buildLnIndex(iedNode) {
  const byLd = new Map();
  for (const accessPoint of toArray(iedNode.AccessPoint)) {
    for (const ldevice of toArray(accessPoint.Server?.LDevice)) {
      const lns = [...toArray(ldevice.LN0), ...toArray(ldevice.LN)].map((ln) => ({
        prefix: attr(ln, 'prefix') ?? '',
        lnClass: attr(ln, 'lnClass') ?? '',
        inst: attr(ln, 'inst') ?? '',
        node: ln,
      }));
      byLd.set(attr(ldevice, 'inst') ?? '', lns);
    }
  }
  return byLd;
}

function namedChild(node, tag, name) {
  return toArray(node?.[tag]).find((child) => attr(child, 'name') === name) ?? null;
}

// A node's raw source attribute (esel:datasrc preferred, sAddr otherwise),
// and the addressing-scheme prefix ("db:", "tag:") stripped from it.
function rawSource(node) {
  return attr(node, 'esel:datasrc') ?? attr(node, 'sAddr');
}

function stripScheme(raw) {
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(colon + 1);
}

// A leaf's device-native source, or null when it states none.
function sourceOf(node) {
  const raw = rawSource(node);
  return raw ? stripScheme(raw) : null;
}

// Every source anywhere under `node`, immediates ("imm:...") excluded — the
// DO-level answer when an FCDA names no specific attribute.
function collectSources(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  for (const child of Array.isArray(node) ? node : Object.values(node)) {
    collectSources(child, out);
  }
  if (!Array.isArray(node)) {
    const raw = rawSource(node);
    if (raw && !raw.includes('imm')) out.push(stripScheme(raw));
  }
  return out;
}

// Units live beside the value: an SDI named "units" holding SIUnit and
// multiplier DAIs ("k" + "W" -> "kW").
function unitsOf(node) {
  const unitSdi = namedChild(node, 'SDI', 'units');
  if (!unitSdi) return null;
  const si = text(toArray(namedChild(unitSdi, 'DAI', 'SIUnit')?.Val)[0]);
  const multiplier = text(toArray(namedChild(unitSdi, 'DAI', 'multiplier')?.Val)[0]);
  return si ? `${multiplier}${si}` : null;
}

// One dataset member resolved: the 61850 path it names, the device source it
// maps to (null when the file carries no address model for it), and units.
function resolveFcda(lnIndex, fcda) {
  const doParts = fcda.doName ? fcda.doName.split('.') : [];
  const daParts = fcda.daName ? fcda.daName.split('.') : null;
  const lnRef = `${fcda.ldInst ?? ''}.${fcda.prefix}${fcda.lnClass ?? ''}${fcda.lnInst}`;
  const pathFor = (parts, tail) =>
    `${lnRef}${parts.length ? `.${parts.join('.')}` : ''}${tail}`;

  const ln = (lnIndex.get(fcda.ldInst ?? '') ?? []).find(
    (candidate) =>
      candidate.inst === fcda.lnInst
      && candidate.lnClass === (fcda.lnClass ?? '')
      && candidate.prefix === fcda.prefix,
  );
  const doi = ln && doParts.length ? namedChild(ln.node, 'DOI', doParts[0]) : null;

  if (!doi) {
    return { path: pathFor(doParts, daParts ? `.${daParts.join('.')}` : '.*'), source: null, units: null };
  }

  if (!daParts) {
    // DO-level member: every non-immediate source under the DO rides along.
    const sources = [...new Set(collectSources(doi))];
    return {
      path: pathFor(doParts, '.*'),
      source: sources.length ? sources.join(', ') : null,
      units: null,
    };
  }

  // Attribute-level member: descend named SDIs for the deeper doName parts,
  // then DAI/SDI links for each daName part.
  let current = doi;
  for (const part of doParts.slice(1)) {
    current = namedChild(current, 'SDI', part);
    if (!current) break;
  }
  const units = current ? unitsOf(current) : null;
  for (const part of current ? daParts : []) {
    current = namedChild(current, 'DAI', part) ?? namedChild(current, 'SDI', part);
    if (!current) break;
  }

  return {
    path: pathFor(doParts, `.${daParts.join('.')}`),
    source: current ? sourceOf(current) : null,
    units,
  };
}

// --- IED section -------------------------------------------------------------

function parseFcda(fcda) {
  return {
    ldInst: attr(fcda, 'ldInst'),
    prefix: attr(fcda, 'prefix') ?? '',
    lnClass: attr(fcda, 'lnClass'),
    lnInst: attr(fcda, 'lnInst') ?? '',
    doName: attr(fcda, 'doName'),
    daName: attr(fcda, 'daName'),
    fc: attr(fcda, 'fc'),
  };
}

// SEL wraps per-control transmit parameters in Private elements.
function parseGoosePrivates(cb) {
  let txAddress = null;
  let minTime = null;
  let maxTime = null;
  for (const priv of toArray(cb.Private)) {
    switch (attr(priv, 'type')) {
      case 'SEL_GOOSETXAddress':
        txAddress = pValues(priv['esel:Address']);
        break;
      case 'SEL_GOOSETXMinTime':
        minTime = text(priv['esel:MinTime']);
        break;
      case 'SEL_GOOSETXMaxTime':
        maxTime = text(priv['esel:MaxTime']);
        break;
      default:
        break;
    }
  }
  return { txAddress, minTime: minTime || null, maxTime: maxTime || null };
}

// <TrgOps dchg="true"/> style option elements: attribute map, or {} when the
// element is absent/empty (fast-xml-parser yields '' for a bare element).
function optionAttrs(node, names) {
  const out = {};
  for (const name of names) {
    out[name] = node && typeof node === 'object' ? attr(node, name) === 'true' : false;
  }
  return out;
}

// Control blocks and datasets sit on LN0 by the letter of the schema, but the
// standard allows them on any LN — collect from every logical node alike.
function parseControls(logicalNodes, lnIndex) {
  const datasets = [];
  const gooseControls = [];
  const reportControls = [];
  const smvControls = [];

  for (const ln of logicalNodes) {
    for (const ds of toArray(ln.DataSet)) {
      const members = toArray(ds.FCDA).map(parseFcda);
      datasets.push({
        name: attr(ds, 'name'),
        desc: attr(ds, 'desc'),
        points: members.map((fcda) => ({ fc: fcda.fc, ...resolveFcda(lnIndex, fcda) })),
      });
    }
    for (const cb of toArray(ln.GSEControl)) {
      gooseControls.push({
        name: attr(cb, 'name'),
        desc: attr(cb, 'desc'),
        datSet: attr(cb, 'datSet'),
        appId: attr(cb, 'appID'),
        confRev: attr(cb, 'confRev'),
        ...parseGoosePrivates(cb),
      });
    }
    for (const cb of toArray(ln.ReportControl)) {
      reportControls.push({
        name: attr(cb, 'name'),
        desc: attr(cb, 'desc'),
        datSet: attr(cb, 'datSet'),
        rptId: attr(cb, 'rptID'),
        buffered: attr(cb, 'buffered') === 'true',
        bufTime: attr(cb, 'bufTime'),
        confRev: attr(cb, 'confRev'),
        intgPd: cb.TrgOps && typeof cb.TrgOps === 'object' ? attr(cb.TrgOps, 'intgPd') : null,
        trgOps: optionAttrs(cb.TrgOps, ['dchg', 'dupd', 'qchg', 'period']),
        optFields: optionAttrs(cb.OptFields, [
          'seqNum', 'timeStamp', 'dataSet', 'reasonCode', 'dataRef', 'bufOvfl', 'entryID', 'configRef',
        ]),
        maxClients: cb.RptEnabled && typeof cb.RptEnabled === 'object' ? attr(cb.RptEnabled, 'max') : null,
      });
    }
    for (const cb of toArray(ln.SampledValueControl)) {
      smvControls.push({
        name: attr(cb, 'name'),
        desc: attr(cb, 'desc'),
        datSet: attr(cb, 'datSet'),
        smvId: attr(cb, 'smvID'),
        confRev: attr(cb, 'confRev'),
      });
    }
  }

  return { datasets, gooseControls, reportControls, smvControls };
}

// The received point's data path, publisher-side: which control block carries
// it and which named data it is. A ref without publisher coordinates beyond
// the control block is that block's message quality.
function extRefSource(ref) {
  const control = `${ref.publisher}/${ref.srcLDInst ?? ''}/${ref.srcLNClass ?? ''}/${ref.srcCBName ?? ''}`;
  if (!ref.ldInst) return `${control} - message quality`;
  const data = `${ref.ldInst}.${ref.prefix ?? ''}${ref.lnClass ?? ''}${ref.lnInst ?? ''}.${ref.doName ?? ''}`;
  return `${control}.${data}.${ref.daName ?? '*'}`;
}

// "SPS001.stVal" -> ["SPS", 1]: the subscriber's internal-address family and
// slot number, the order the receive map is authored in.
function splitIntAddr(intAddr) {
  const match = /^(\D*)(\d*)/.exec(intAddr ?? '');
  return [match[1], match[2] ? Number(match[2]) : 0];
}

// A bound ExtRef names the data it consumes (publisher-side coordinates) and
// the control block that carries it; an unbound one is an empty template slot.
function parseExtRefs(logicalNodes) {
  const bound = [];
  let unbound = 0;

  for (const ln of logicalNodes) {
    for (const inputs of toArray(ln.Inputs)) {
      for (const ref of toArray(inputs.ExtRef)) {
        const publisher = attr(ref, 'iedName');
        if (!publisher) {
          unbound += 1;
          continue;
        }
        const parsed = {
          publisher,
          serviceType: attr(ref, 'serviceType'),
          ldInst: attr(ref, 'ldInst'),
          prefix: attr(ref, 'prefix'),
          lnClass: attr(ref, 'lnClass'),
          lnInst: attr(ref, 'lnInst'),
          doName: attr(ref, 'doName'),
          daName: attr(ref, 'daName'),
          srcLDInst: attr(ref, 'srcLDInst'),
          srcLNClass: attr(ref, 'srcLNClass'),
          srcCBName: attr(ref, 'srcCBName'),
          intAddr: (attr(ref, 'intAddr') ?? '').split('|')[0] || null,
        };
        bound.push({ ...parsed, source: extRefSource(parsed) });
      }
    }
  }

  // Receive-map order: internal-address family, then slot number.
  bound.sort((a, b) => {
    const [aFamily, aSlot] = splitIntAddr(a.intAddr);
    const [bFamily, bSlot] = splitIntAddr(b.intAddr);
    return aFamily < bFamily ? -1 : aFamily > bFamily ? 1 : aSlot - bSlot;
  });

  return { bound, unbound };
}

function parseLDevice(ldevice, lnIndex) {
  const logicalNodes = [...toArray(ldevice.LN0), ...toArray(ldevice.LN)];
  const { bound, unbound } = parseExtRefs(logicalNodes);
  return {
    inst: attr(ldevice, 'inst'),
    desc: attr(ldevice, 'desc'),
    logicalNodes: logicalNodes.length,
    ...parseControls(logicalNodes, lnIndex),
    extRefs: bound,
    unboundExtRefs: unbound,
  };
}

// One subscription row per (publisher, service, control block), with the
// number of bound points riding it — the declared-link summary the canvas
// linker consumes.
function summarizeSubscriptions(ldevices) {
  const groups = new Map();
  for (const ldevice of ldevices) {
    for (const ref of ldevice.extRefs) {
      const key = [ref.publisher, ref.serviceType, ref.srcLDInst, ref.srcCBName].join('|');
      const group = groups.get(key);
      if (group) {
        group.points += 1;
        continue;
      }
      groups.set(key, {
        publisher: ref.publisher,
        serviceType: ref.serviceType,
        control: ref.srcCBName
          ? [ref.srcLDInst, ref.srcCBName].filter(Boolean).join('/')
          : null,
        points: 1,
      });
    }
  }
  return [...groups.values()];
}

// SEL_IedInfo Private: the device pedigree Architect stamps on each IED —
// child elements, ModelNumber repeated once per compatible model.
function parseIedInfo(ied) {
  for (const priv of toArray(ied.Private)) {
    if (attr(priv, 'type') === 'SEL_IedInfo') {
      return {
        firmware: text(toArray(priv['esel:ModelVersionMin'])[0]) || null,
        classVersion: text(toArray(priv['esel:ClassFileVersion'])[0]) || null,
        modelNumbers: toArray(priv['esel:ModelNumber']).map((node) => text(node)).filter(Boolean),
        icdFile: text(toArray(priv['esel:IcdFilePath'])[0]) || null,
      };
    }
  }
  return { firmware: null, classVersion: null, modelNumbers: [], icdFile: null };
}

function parseIed(ied) {
  const lnIndex = buildLnIndex(ied);
  const accessPoints = toArray(ied.AccessPoint).map((accessPoint) => ({
    name: attr(accessPoint, 'name'),
    desc: attr(accessPoint, 'desc'),
    ldevices: toArray(accessPoint.Server?.LDevice).map((ldevice) => parseLDevice(ldevice, lnIndex)),
  }));
  const ldevices = accessPoints.flatMap((accessPoint) => accessPoint.ldevices);

  return {
    name: attr(ied, 'name'),
    desc: attr(ied, 'desc'),
    type: attr(ied, 'type'),
    manufacturer: attr(ied, 'manufacturer'),
    configVersion: attr(ied, 'configVersion'),
    ...parseIedInfo(ied),
    accessPoints,
    subscriptions: summarizeSubscriptions(ldevices),
  };
}

// --- assembly ----------------------------------------------------------------

function countAll(ieds, pick) {
  return ieds
    .flatMap((ied) => ied.accessPoints)
    .flatMap((accessPoint) => accessPoint.ldevices)
    .reduce((total, ldevice) => total + pick(ldevice), 0);
}

// Every ConnectedAP belonging to one IED, with its subnetwork — the model
// query both the inspect view and the extractor navigate by.
function connectedAps(model, iedName) {
  return model.subNetworks
    .flatMap((subNetwork) => subNetwork.connectedAps.map((ap) => ({ subNetwork, ap })))
    .filter(({ ap }) => ap.iedName === iedName);
}

// Every (accessPoint, ldevice) pair of a parsed IED, tree order — the
// traversal the inspect sections and the extractor share.
function ldevicesOf(ied) {
  return ied.accessPoints.flatMap((accessPoint) =>
    accessPoint.ldevices.map((ldevice) => ({ accessPoint, ldevice })));
}

// The wire address of one GOOSE publication: the Communication section's GSE
// entry when present (matched by control-block name; ldInst wildcarded when
// the entry omits it), the SEL private on the control block otherwise. The
// trickiest merge rule in the SCD path — inspect and the canvas share it.
function wireAddressFor(gses, ldevice, cb) {
  const wire = gses.find(
    (candidate) => candidate.cbName === cb.name
      && (!candidate.ldInst || candidate.ldInst === ldevice.inst),
  ) ?? null;
  return { wire, address: wire?.address ?? cb.txAddress ?? null };
}

// Parse one SCL document (raw XML string) into the SCD model.
function parseScd(xmlString) {
  const doc = parseXml(xmlString);
  const scl = doc?.SCL;
  if (!scl) {
    throw new Error('missing <SCL> root — not an SCL/SCD file');
  }

  const header = scl.Header
    ? {
        id: attr(scl.Header, 'id'),
        version: attr(scl.Header, 'version'),
        revision: attr(scl.Header, 'revision'),
        toolId: attr(scl.Header, 'toolID'),
      }
    : null;

  const subNetworks = parseSubNetworks(scl.Communication);
  const ieds = toArray(scl.IED).map(parseIed);

  return {
    header,
    ieds,
    subNetworks,
    summary: {
      ieds: ieds.length,
      subNetworks: subNetworks.length,
      connectedAps: subNetworks.reduce((total, sn) => total + sn.connectedAps.length, 0),
      gooseControls: countAll(ieds, (ld) => ld.gooseControls.length),
      reportControls: countAll(ieds, (ld) => ld.reportControls.length),
      smvControls: countAll(ieds, (ld) => ld.smvControls.length),
      boundExtRefs: countAll(ieds, (ld) => ld.extRefs.length),
      unboundExtRefs: countAll(ieds, (ld) => ld.unboundExtRefs),
    },
  };
}

export { connectedAps, ldevicesOf, parseScd, wireAddressFor };
