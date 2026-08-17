// Kind registry for the RTAC export parser.
//
// Every export file is one <RTACModule> whose first non-ExportSource child
// names what the file *is* — a Device (connection), a TagList, a POU, an
// EtherCAT network, a custom-application extension, and so on. Rather than a
// hard-coded allowlist scattered through the parser, each kind is described
// here once:
//
//   {
//     category: how layer 2 and the UI should group it,
//     label:    human name for the UI,
//     extract:  optional (container, helpers) => extra structural fields
//   }
//
// A kind missing from this table still parses: the module keeps its real
// element name as `kind`, gets category 'other', and its name + setting pages
// are captured by the generic path in parseModule.js. Adding first-class
// support for a new RTAC object type is one entry in this table.

import { cdata, findFirst, text, toArray } from '../xml.js';

// Categories the rest of the pipeline understands:
//   connection — a protocol client/server/peer (Device files)
//   tagList    — a point map (server shared maps, virtual tag lists)
//   logic      — user IEC 61131 code (POU / GVL / DataType)
//   system     — controller built-ins (contact I/O, system tags, time, ...)
//   hardware   — physical I/O topology (Axion EtherCAT network)
//   extension  — custom applications and their definitions
//   meta       — project-level files (project info, navigator layout)
//   other      — anything this registry has never heard of

// --- kind-specific extractors -----------------------------------------------

function extractDevice(container) {
  // An NGVL connection (network global variable list) carries its variable
  // list as a <Variables> CDATA of IEC 61131 source (VAR_GLOBAL … END_VAR)
  // under its <Connection> — the variables ARE the object, so surface them
  // the way a GVL surfaces its body.
  const variables = findFirst(container, 'Variables');
  return {
    protocol: text(findFirst(container, 'Protocol')) || null,
    connectionType: text(findFirst(container, 'ConnectionType')) || null,
    manufacturer: text(findFirst(container, 'Manufacturer')) || null,
    model: text(findFirst(container, 'Model')) || null,
    ...(variables !== undefined ? { code: { implementation: cdata(variables) || null } } : {}),
  };
}

function extractTagList(container) {
  return { tagListType: text(findFirst(container, 'TagListType')) || null };
}

// POU content comes in two shapes: plain ST as <Content><Interface>/
// <Implementation> CDATA, or graphical CFC/LD as an <ArchivedContent> blob
// (CoDeSys serialized XML) — the blob's presence flag and fingerprint are
// captured generically in parseModule.js.
function extractPou(container) {
  const content = findFirst(container, 'Content');
  return {
    pouKind: text(findFirst(container, 'POUKind')) || null, // Program | FunctionBlock | ...
    code: content
      ? {
          interface: cdata(content.Interface) || null,
          implementation: cdata(content.Implementation) || null,
        }
      : null,
  };
}

// GVL and DataType carry one CDATA body of IEC 61131 source.
function extractCodeBody(container) {
  const content = findFirst(container, 'Content');
  return { code: content !== undefined ? { implementation: cdata(content) || null } : null };
}

function extractCustomApplication(container) {
  return {
    definitionName: text(findFirst(container, 'DefinitionName')) || null,
    definitionVersion: text(findFirst(container, 'DefinitionVersion')) || null,
  };
}

function extractCustomApplicationDefinition(container) {
  const files = toArray(findFirst(container, 'Files')?.File).map((file) => ({
    name: file?.['@_name'] ?? null,
    functions: toArray(file?.Function).map((fn) => ({
      name: fn?.['@_name'] ?? null,
      type: fn?.['@_type'] ?? null,
    })),
  }));
  return {
    version: text(findFirst(container, 'Version')) || null,
    description: text(findFirst(container, 'Description')) || null,
    files,
  };
}

// Axion I/O topology: nodes of slots, each slot holding a module device name.
function extractEtherCatNetwork(container) {
  const nodes = toArray(findFirst(container, 'Nodes')?.Node).map((node) => ({
    name: text(node?.Name) || null,
    slotCount: text(node?.SlotCount) || null,
    startingSlot: text(node?.StartingSlot) || null,
    slots: toArray(findFirst(node ?? {}, 'Slots')?.Slot).map((slot) => {
      const out = {};
      for (const [key, value] of Object.entries(slot ?? {})) {
        if (!key.startsWith('@_')) out[key] = text(value);
      }
      return out;
    }),
  }));
  return { nodes };
}

// The navigator layout is the project tree as the RTAC UI shows it; keep the
// item hierarchy so a renderer could reproduce the exact ordering.
function extractNavigatorLayout(container) {
  const mapItems = (node) =>
    toArray(node?.Items?.Item).map((item) => ({
      name: item?.['@_Name'] ?? null,
      isFolder: item?.['@_IsFolder'] === 'true',
      items: mapItems(item),
    }));
  return { layout: mapItems(container) };
}

function extractProjectInfo(container) {
  return { description: cdata(findFirst(container, 'Description')) || null };
}

// --- the registry ------------------------------------------------------------

const KIND_REGISTRY = new Map(Object.entries({
  Device: { category: 'connection', label: 'Connection', extract: extractDevice },
  TagList: { category: 'tagList', label: 'Tag List', extract: extractTagList },
  POU: { category: 'logic', label: 'POU', extract: extractPou },
  GVL: { category: 'logic', label: 'Global Variable List', extract: extractCodeBody },
  DataType: { category: 'logic', label: 'Data Type', extract: extractCodeBody },
  TagProcessor: { category: 'system', label: 'Tag Processor' },
  AccessPointRouter: { category: 'system', label: 'Access Point Router' },
  ContactIO: { category: 'system', label: 'Contact I/O' },
  MainController: { category: 'system', label: 'Main Controller' },
  SystemTags: { category: 'system', label: 'System Tags' },
  SystemTimeControl: { category: 'system', label: 'System Time Control' },
  EtherCATNetwork: { category: 'hardware', label: 'EtherCAT I/O Network', extract: extractEtherCatNetwork },
  CustomApplication: { category: 'extension', label: 'Custom Application', extract: extractCustomApplication },
  CustomApplicationDefinition: {
    category: 'extension',
    label: 'Custom Application Definition',
    extract: extractCustomApplicationDefinition,
  },
  ProjectInfo: { category: 'meta', label: 'Project Info', extract: extractProjectInfo },
  NavigatorLayout: { category: 'meta', label: 'Navigator Layout', extract: extractNavigatorLayout },
}));

// Elements under <RTACModule> that are not the kind-naming container.
const NON_KIND_CHILDREN = new Set(['ExportSource', '?xml']);

function describeKind(kind) {
  return KIND_REGISTRY.get(kind) ?? { category: 'other', label: kind };
}

export { NON_KIND_CHILDREN, describeKind };
