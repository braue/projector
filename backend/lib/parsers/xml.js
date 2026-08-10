// XML helpers shared by the settings-artifact parsers (RTAC exports, SCL/SCD
// files) — all UTF-8 XML, some files carrying a BOM.
//
// fast-xml-parser collapses a single repeated element to an object instead of
// an array, so every access to a "list" node must go through toArray().

import { XMLParser } from 'fast-xml-parser';

// parseTagValue:false keeps every leaf as a raw string. That matters: point
// numbers, IP addresses, "0"/"True"/"OFF" enums and comma lists must survive
// verbatim so the semantic layer — not the XML layer — decides how to coerce.
const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: '__cdata',
  processEntities: true,
};

// One parser instance per stopNodes config (options are fixed at construction).
const parsers = new Map();

function parserFor(stopNodes) {
  const key = stopNodes?.join('|') ?? '';
  if (!parsers.has(key)) {
    parsers.set(key, new XMLParser(stopNodes ? { ...PARSER_OPTIONS, stopNodes } : PARSER_OPTIONS));
  }
  return parsers.get(key);
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

// `stopNodes` (e.g. ['*.ControllerPOU']) names elements whose bodies are kept
// as one unparsed string — presence stays exact, tokenization cost disappears.
function parseXml(xmlString, stopNodes) {
  return parserFor(stopNodes).parse(stripBom(xmlString));
}

// Attribute value ('@_' prefix per the parser config above); null when the
// attribute is absent or empty.
function attr(node, name) {
  const value = node?.[`@_${name}`];
  return value === undefined || value === '' ? null : String(value);
}

// Normalize fast-xml-parser output (object | array | undefined) to an array.
function toArray(node) {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

// Leaf text for a node that may be "", undefined, or a { '#text', '@_...' } object.
function text(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    if ('#text' in node) return String(node['#text']);
    if ('__cdata' in node) return String(node.__cdata);
  }
  return '';
}

// CDATA-aware leaf text: RTAC wraps source code (ST/GVL/DataType bodies) in
// CDATA; fast-xml-parser stores it under __cdata. Falls back to plain text.
function cdata(node) {
  if (node && typeof node === 'object' && '__cdata' in node) return String(node.__cdata);
  return text(node);
}

// Depth-first search collecting every value stored under `key`, anywhere in the
// tree. Used to locate SettingPage / Protocol nodes without hard-coding paths.
function collect(obj, key, out = []) {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) {
      for (const item of toArray(v)) out.push(item);
    }
    if (v && typeof v === 'object') collect(v, key, out);
  }
  return out;
}

// First value stored under `key` anywhere in the tree, or undefined.
function findFirst(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) return Array.isArray(v) ? v[0] : v;
    if (v && typeof v === 'object') {
      const found = findFirst(v, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export { attr, cdata, collect, findFirst, parseXml, text, toArray };
