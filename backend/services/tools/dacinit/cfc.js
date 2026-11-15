// CFC diagrams (the AreaMap and the per-circuit fault programs) as AcSELerator
// exports them: a POU whose <ArchivedContent> CDATA is a serialized object
// graph. The graph's Implementation holds a flat list of elements — boxes
// (function blocks / method calls) with their input and output pins, input
// and output variable boxes, comments, connection marks — then the
// connections (source pin -> destination pin), and a routing table giving
// each connection's drawn path. A counter (UniqueIdGenerator) holds the last
// id handed out. Every element, pin, text and connection has an id from that
// one counter.
//
// Geometry, as every CLECO scheme draws it: a box's anchor is its Bounds
// x, y. Input pin i sits at (x - 1, y + 2 + i), output pin j at
// (x + width, y + 2 + j), where width depends only on the box's type text
// (DA_REC.AiBo is 6 wide). A route is a list of grid points from the source
// pin to the destination pin. Each point carries a flag set: 64 start, 32
// end, 16 joint, plus the directions its segments leave in (1 left, 2 up,
// 4 right, 8 down). A straight wire is [start 68, end 97].

import * as X from './xmltree.js';

const GUID = {
  box: 'f5becf35-b1f3-4274-b411-81d4b63a1516',
  inPin: 'c994f6e0-311a-4a1c-bc38-75fe34892406',
  outPin: '65582d84-cf18-4ca0-be59-bf5a3d00b8f8',
  text: '72f2b13f-5349-4a8a-bbe6-2bccf3f42179',
  connection: '5ae2e111-ecff-4a21-b647-2d4da63f8db7',
  comment: '3487d131-7fd4-48ac-9e99-9e275c3b8ff8',
  inputVar: 'd51129f5', // prefix match: input variable (one output pin)
  outputVar: '8d9e2b78', // output variable (one input pin)
  markSink: 'cfa51168-a508-4d4f-a62d-d65bd44a895b',
  markSource: '9e94943e-4951-4da7-a4e2-1f1bb71a6228',
  point: 'b3e42b54-b8f2-45d3-825d-747f82f244a0',
};

const ARCHIVE = /(<ArchivedContent><!\[CDATA\[)([\s\S]*)(\]\]><\/ArchivedContent>)/;

function kindOf(node) {
  const guid = X.typeGuid(node) ?? '';
  for (const [kind, g] of Object.entries(GUID)) if (guid.startsWith(g)) return kind;
  return 'other';
}

const leaf = (node, name) => X.textOf(X.field(node, name));
const setLeaf = (node, name, value) => X.setText(X.field(node, name), String(value));
const pinList = (node, name) => {
  const list = X.field(node, name);
  return list ? X.elements(X.field(list, 'InnerList')) : [];
};
const textsOf = (node) => {
  const list = X.field(node, 'Texts');
  return list ? X.elements(X.field(list, 'InnerList')) : [];
};

function bounds(node) {
  const [x, y] = leaf(node, 'Bounds').split(',').map((v) => Number(v.trim()));
  return { x, y };
}
function setBounds(node, x, y) {
  const rest = leaf(node, 'Bounds').split(',').slice(2).map((v) => v.trim());
  setLeaf(node, 'Bounds', [x, y, ...rest].join(', '));
}

/** One element of the diagram, indexed: its kind, ids, pins and position. */
function describe(node) {
  const kind = kindOf(node);
  const el = { node, kind, id: leaf(node, 'Id'), ins: [], outs: [] };
  if (kind === 'connection') {
    el.src = leaf(node, 'SourcePinId');
    el.dst = leaf(node, 'DestPinId');
    return el;
  }
  if (X.field(node, 'Bounds')) Object.assign(el, bounds(node));
  if (kind === 'box') {
    el.ins = pinList(node, 'Inputs').map((p) => leaf(p, 'Id'));
    el.outs = pinList(node, 'Outputs').map((p) => leaf(p, 'Id'));
    const texts = textsOf(node).map((t) => leaf(t, 'Text'));
    // Pin names, then the type ("DA_REC.AiBo"), then the instance ("R6267").
    el.type = texts[texts.length - 2];
    el.name = texts[texts.length - 1];
    el.pinNames = texts.slice(0, el.ins.length + el.outs.length);
  } else if (kind === 'inputVar' || kind === 'markSource') {
    el.outs = [leaf(X.field(node, 'Output'), 'Id')];
    el.name = leaf(X.field(node, 'Text'), 'Text');
  } else if (kind === 'outputVar' || kind === 'markSink') {
    el.ins = [leaf(X.field(node, 'Input'), 'Id')];
    el.name = leaf(X.field(node, 'Text'), 'Text');
  } else if (kind === 'comment') {
    el.name = leaf(X.field(node, 'Text'), 'Text');
  }
  return el;
}

class Cfc {
  constructor(xml) {
    const m = ARCHIVE.exec(xml);
    if (!m) throw new Error('not a CFC export (no ArchivedContent)');
    this.head = xml.slice(0, m.index) + m[1];
    this.tail = m[3] + xml.slice(m.index + m[0].length);
    this.doc = X.parse(m[2]);
    this.root = X.elements(this.doc).find((n) => X.tagName(n) === 'Single');
    const impl = X.field(this.root, 'Implementation');
    this.impl = impl;
    this.list = X.field(X.field(impl, 'Items'), 'InnerList');
    this.routes = X.field(X.field(impl, 'RoutingPathTable'), 'InnerDictionary');
    this.index();
  }

  toXml() {
    return this.head + X.serialize(this.doc) + this.tail;
  }

  /** (Re)build the element, pin and route indexes from the tree. */
  index() {
    this.elements = X.elements(this.list).map(describe);
    this.byId = new Map(this.elements.map((el) => [el.id, el]));
    this.pinOwner = new Map();
    for (const el of this.elements) {
      el.ins.forEach((pin, i) => this.pinOwner.set(pin, { el, side: 'in', i }));
      el.outs.forEach((pin, i) => this.pinOwner.set(pin, { el, side: 'out', i }));
    }
    this.connections = this.elements.filter((el) => el.kind === 'connection');
    this.routeOf = new Map();
    for (const entry of this.routes ? X.elements(this.routes) : []) {
      const key = X.elements(X.child(entry, 'Key'))[0];
      this.routeOf.set(leaf(key, 'ConnectionId'), entry);
    }
  }

  get uid() { return Number(leaf(this.root, 'UniqueIdGenerator')); }
  /** Hand out the next id (the counter holds the last one used). */
  nextId() {
    const id = this.uid + 1;
    setLeaf(this.root, 'UniqueIdGenerator', id);
    return String(id);
  }

  boxes() { return this.elements.filter((el) => el.kind === 'box'); }
  box(name) {
    const key = String(name).toLowerCase();
    return this.boxes().find((el) => String(el.name).toLowerCase() === key) ?? null;
  }

  // --- the declaration (VAR … END_VAR) ---------------------------------------

  get declaration() {
    return leaf(X.field(X.field(this.root, 'Interface'), 'TextDocument'), 'TextBlobForSerialisation');
  }
  set declaration(text) {
    setLeaf(X.field(X.field(this.root, 'Interface'), 'TextDocument'), 'TextBlobForSerialisation', text);
  }

  // --- routes --------------------------------------------------------------

  routePoints(connId) {
    const entry = this.routeOf.get(connId);
    if (!entry) return null;
    const list = X.field(X.elements(X.child(entry, 'Value'))[0], 'InnerList');
    return X.elements(list).map((p) => ({
      x: Number(leaf(p, 'X')), y: Number(leaf(p, 'Y')), joint: leaf(p, 'IsJoint') === 'True', flags: Number(leaf(p, 'Flags')),
    }));
  }

  /** Rewrite a connection's route (creating its entry from a sibling's shape if new). */
  setRoute(connId, points, { unroutable = false } = {}) {
    let entry = this.routeOf.get(connId);
    if (!entry) {
      const template = X.elements(this.routes)[0] ?? (this.donor && X.elements(this.donor.routes)[0]);
      if (!template) throw new Error('the diagram has no routing table entry to copy');
      entry = X.clone(template);
      X.insertAfter(this.routes, null, [entry]);
      this.routeOf.set(connId, entry);
    }
    const key = X.elements(X.child(entry, 'Key'))[0];
    setLeaf(key, 'ConnectionId', connId);
    setLeaf(key, 'Unroutable', unroutable ? 'True' : 'False');
    const start = X.field(key, 'StartPoint');
    setLeaf(start, 'X', points[0].x);
    setLeaf(start, 'Y', points[0].y);
    setLeaf(start, 'IsJoint', 'False');
    setLeaf(start, 'Flags', 0);
    const list = X.field(X.elements(X.child(entry, 'Value'))[0], 'InnerList');
    const model = X.elements(list)[0] ?? start;
    for (const old of X.elements(list)) X.remove(old);
    const made = points.map((p) => {
      const node = X.clone(model);
      // A point inside the list is typed by its GUID, not a field name.
      node.open = node.open.replace(/\sName="[^"]*"/, '');
      setLeaf(node, 'X', p.x);
      setLeaf(node, 'Y', p.y);
      setLeaf(node, 'IsJoint', p.joint ? 'True' : 'False');
      setLeaf(node, 'Flags', p.flags);
      return node;
    });
    X.insertAfter(list, null, made);
  }

  /** Empty the diagram: no elements, connections or routes. */
  clear() {
    for (const el of [...this.elements]) X.remove(el.node);
    for (const entry of X.elements(this.routes)) X.remove(entry);
    this.index();
  }

  removeRoute(connId) {
    const entry = this.routeOf.get(connId);
    if (entry) X.remove(entry);
    this.routeOf.delete(connId);
  }

  // --- geometry --------------------------------------------------------------

  /** Box widths by type text, from where existing wires leave each type. */
  widths() {
    if (this._widths) return this._widths;
    const tally = new Map();
    for (const conn of this.connections) {
      const own = this.pinOwner.get(conn.src);
      const pts = this.routePoints(conn.id);
      if (!own || own.el.kind !== 'box' || !pts?.length || pts[0].flags === 0) continue;
      const key = own.el.type.toLowerCase();
      const w = pts[0].x - own.el.x;
      const counts = tally.get(key) ?? new Map();
      counts.set(w, (counts.get(w) ?? 0) + 1);
      tally.set(key, counts);
    }
    this._widths = new Map([...tally].map(([k, counts]) => [k, [...counts].sort((a, b) => b[1] - a[1])[0][0]]));
    return this._widths;
  }

  width(el) {
    if (el.kind !== 'box') return 0;
    return this.widths().get(el.type.toLowerCase()) ?? DEFAULT_WIDTH[el.type.toLowerCase()] ?? 6;
  }

  /** Grid point of a pin. */
  pinPoint(pinId) {
    const own = this.pinOwner.get(pinId);
    if (!own) return null;
    const { el, side, i } = own;
    if (el.kind === 'box') {
      return side === 'in' ? { x: el.x - 1, y: el.y + 2 + i } : { x: el.x + this.width(el), y: el.y + 2 + i };
    }
    // Variable boxes and marks: the pin is on the anchor row; an output's x
    // is only known from a wire that leaves it.
    if (side === 'in') return { x: el.x - 1, y: el.y };
    const conn = this.connections.find((c) => c.src === pinId);
    const pts = conn && this.routePoints(conn.id);
    return pts?.length ? { x: pts[0].x, y: pts[0].y } : { x: el.x + 6, y: el.y };
  }

  moveElement(el, dx, dy) {
    el.x += dx;
    el.y += dy;
    setBounds(el.node, el.x, el.y);
  }

  /** Grow the canvas size fields to hold every element. */
  fitCanvas() {
    let w = 0;
    let h = 0;
    for (const el of this.elements) {
      if (el.x == null) continue;
      w = Math.max(w, el.x + this.width(el) + 2);
      h = Math.max(h, el.y + 4 + Math.max(el.ins.length, el.outs.length));
    }
    for (const [name, v] of [['CanvasWidth', w], ['CanvasHeight', h]]) {
      const node = X.field(this.impl, name);
      if (node && Number(X.textOf(node)) < v) X.setText(node, String(v));
    }
  }

  // --- building ----------------------------------------------------------------

  /**
   * Copy an element with fresh ids for it and everything inside it (pins,
   * texts), and insert it after `after` (or at the end of the element list,
   * ahead of the connections). Returns the new element, indexed.
   */
  cloneElement(template, { after = null, x, y } = {}) {
    const node = X.clone(template.node);
    for (const n of X.walk(node)) {
      const id = X.field(n, 'Id');
      if (id && X.textOf(id) !== '') X.setText(id, this.nextId());
    }
    const anchor = after ?? this.elements.filter((el) => el.kind !== 'connection').pop() ?? null;
    X.insertAfter(this.list, anchor?.node ?? null, [node]);
    const el = describe(node);
    this.elements.splice(anchor ? this.elements.indexOf(anchor) + 1 : this.elements.length, 0, el);
    this.byId.set(el.id, el);
    el.ins.forEach((pin, i) => this.pinOwner.set(pin, { el, side: 'in', i }));
    el.outs.forEach((pin, i) => this.pinOwner.set(pin, { el, side: 'out', i }));
    if (x != null) this.moveElement(el, x - el.x, y - el.y);
    return el;
  }

  /** Set the instance name of a box (its last text) or the text of a var/comment/mark. */
  rename(el, name) {
    if (el.kind === 'box') {
      const texts = textsOf(el.node);
      setLeaf(texts[texts.length - 1], 'Text', name);
    } else {
      setLeaf(X.field(el.node, 'Text'), 'Text', name);
    }
    el.name = name;
  }

  /** Add a connection from an output pin to an input pin, with a route. */
  connect(src, dst, points) {
    // An emptied diagram borrows the archive shape from `donor` (the Cfc its
    // contents are copied from).
    const template = this.connections[0] ?? this.donor?.connections[0];
    if (!template) throw new Error('the diagram has no connection to copy');
    const node = X.clone(template.node);
    const id = this.nextId();
    setLeaf(node, 'SourcePinId', src);
    setLeaf(node, 'DestPinId', dst);
    setLeaf(node, 'Id', id);
    X.insertAfter(this.list, this.connections[this.connections.length - 1]?.node ?? null, [node]);
    const el = describe(node);
    this.elements.push(el);
    this.connections.push(el);
    this.byId.set(id, el);
    this.setRoute(id, points ?? autoRoute(this.pinPoint(src), this.pinPoint(dst)));
    return el;
  }

  disconnect(conn) {
    X.remove(conn.node);
    this.removeRoute(conn.id);
    this.connections.splice(this.connections.indexOf(conn), 1);
    this.elements.splice(this.elements.indexOf(conn), 1);
    this.byId.delete(conn.id);
  }

  setDestination(conn, pin) {
    setLeaf(conn.node, 'DestPinId', pin);
    conn.dst = pin;
  }

  /** Recompute a connection's route from its pins, keeping a bend column if it still fits. */
  reroute(conn, bendX) {
    const from = this.pinPoint(conn.src);
    const to = this.pinPoint(conn.dst);
    if (!from || !to) return;
    if (to.x <= from.x && to.y !== from.y) {
      // Backward wires: draw straight and let the editor route them, as the
      // schemes' own unroutable wires are stored.
      this.setRoute(conn.id, [{ x: from.x, y: from.y, flags: 0 }, { x: to.x, y: to.y, flags: 0 }], { unroutable: true });
      return;
    }
    this.setRoute(conn.id, autoRoute(from, to, bendX));
  }

  shiftRoute(connId, dx, dy) {
    const pts = this.routePoints(connId);
    if (!pts) return;
    const entry = this.routeOf.get(connId);
    const unroutable = leaf(X.elements(X.child(entry, 'Key'))[0], 'Unroutable') === 'True';
    this.setRoute(connId, pts.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })), { unroutable });
  }
}

const DEFAULT_WIDTH = {
  'da_rec.aibo': 6, 'da_rec.aibi': 6, 'da_rec.biai': 6, 'da_fdr.bo': 6, 'da_fdr.aibo': 6,
  'da_pseudo_bkr.aibo': 10, 'da_sub_transformer.bo': 12,
};

/**
 * A wire from pin `a` (output) to pin `b` (input): straight on one row, else
 * across, down or up at column `bendX`, and across again.
 */
function autoRoute(a, b, bendX) {
  if (a.y === b.y) return [{ x: a.x, y: a.y, flags: 68 }, { x: b.x, y: b.y, flags: 97 }];
  let bx = bendX;
  if (bx == null || bx <= a.x || bx >= b.x) bx = Math.max(a.x + 1, b.x - 2);
  if (bx >= b.x) bx = a.x + Math.floor((b.x - a.x) / 2);
  // A bend's flags name the sides its wire leaves by: 1 left, 2 up, 4 right,
  // 8 down (the schemes: down 9/13 then 6, up 3 then 12).
  const down = b.y > a.y;
  return [
    { x: a.x, y: a.y, flags: 68 },
    { x: bx, y: a.y, flags: 1 | (down ? 8 : 2) },
    { x: bx, y: b.y, flags: 4 | (down ? 2 : 8) },
    { x: b.x, y: b.y, flags: 97 },
  ];
}

export { Cfc, autoRoute, kindOf, GUID };
