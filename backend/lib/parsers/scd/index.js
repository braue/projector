// Parser for IEC 61850 SCL files — the .scd substation configurations tools
// like AcSELerator Architect produce (and, same schema at different scopes,
// .icd/.cid/.ssd device and instance files).
//
// Comm-truth focused: it models the sections purview links on —
//
//   IED             who exists (name, type, manufacturer, logical devices,
//                   what they publish: GOOSE/Report/SMV control blocks over
//                   named datasets)
//   Communication   where they sit (subnetworks, access-point addresses, and
//                   the multicast MAC/APPID/VLAN each GOOSE/SMV publication
//                   uses on the wire)
//   Inputs/ExtRef   what they consume (a bound ExtRef names the publishing
//                   IED and control block — that is a declared link)
//
// Loss-tolerant like the RTAC parser: any section or attribute the schema
// allows to be absent simply yields null/empty, and unknown elements are
// ignored rather than fatal. SEL ICDs ship thousands of pre-provisioned
// UNBOUND ExtRefs (an intAddr slot with no publisher); those are tallied per
// logical device but only bound refs make the subscription list, so the
// model reflects configured links, not template capacity.

import { attr, parseXml, text, toArray } from '../xml.js';

// <P type="IP">1.2.3.4</P> siblings -> { IP: '1.2.3.4', ... }; first wins.
function pValues(container) {
  const out = {};
  for (const p of toArray(container?.P)) {
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

// --- IED section -------------------------------------------------------------

// Control blocks and datasets sit on LN0 by the letter of the schema, but the
// standard allows them on any LN — collect from every logical node alike.
function parseControls(logicalNodes) {
  const datasets = [];
  const gooseControls = [];
  const reportControls = [];
  const smvControls = [];

  for (const ln of logicalNodes) {
    for (const ds of toArray(ln.DataSet)) {
      datasets.push({
        name: attr(ds, 'name'),
        desc: attr(ds, 'desc'),
        points: toArray(ds.FCDA).length,
      });
    }
    for (const cb of toArray(ln.GSEControl)) {
      gooseControls.push({
        name: attr(cb, 'name'),
        desc: attr(cb, 'desc'),
        datSet: attr(cb, 'datSet'),
        appId: attr(cb, 'appID'),
        confRev: attr(cb, 'confRev'),
      });
    }
    for (const cb of toArray(ln.ReportControl)) {
      reportControls.push({
        name: attr(cb, 'name'),
        desc: attr(cb, 'desc'),
        datSet: attr(cb, 'datSet'),
        rptId: attr(cb, 'rptID'),
        buffered: attr(cb, 'buffered') === 'true',
        confRev: attr(cb, 'confRev'),
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
        bound.push({
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
          intAddr: attr(ref, 'intAddr'),
        });
      }
    }
  }

  return { bound, unbound };
}

function parseLDevice(ldevice) {
  const logicalNodes = [...toArray(ldevice.LN0), ...toArray(ldevice.LN)];
  const { bound, unbound } = parseExtRefs(logicalNodes);
  return {
    inst: attr(ldevice, 'inst'),
    desc: attr(ldevice, 'desc'),
    logicalNodes: logicalNodes.length,
    ...parseControls(logicalNodes),
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

function parseIed(ied) {
  const accessPoints = toArray(ied.AccessPoint).map((accessPoint) => ({
    name: attr(accessPoint, 'name'),
    desc: attr(accessPoint, 'desc'),
    ldevices: toArray(accessPoint.Server?.LDevice).map(parseLDevice),
  }));
  const ldevices = accessPoints.flatMap((accessPoint) => accessPoint.ldevices);

  return {
    name: attr(ied, 'name'),
    desc: attr(ied, 'desc'),
    type: attr(ied, 'type'),
    manufacturer: attr(ied, 'manufacturer'),
    configVersion: attr(ied, 'configVersion'),
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

export { connectedAps, parseScd };
