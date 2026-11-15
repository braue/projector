// Placing new devices on the AreaMap — the CFC diagram whose wiring IS the
// scheme's topology: each device is a method-call box (R6267 : DA_REC.AiBo)
// and a wire from one box's output to the next box's input says power flows
// from the first to the second. Every addition in the scheme history does the
// same few things, and this does them the same way:
//
//  - A recloser goes into an existing wire: the wire from its A-side device
//    now ends at the new box, and a new wire runs from the new box on to the
//    B-side device. The new box takes the B-side device's place and that
//    device, with everything right of it on its row, moves right to make
//    room (St Landry 2026: B6310 -> R6268 -> R6267 -> R6318).
//  - A normally-open recloser (DA_REC.AiBi) has two inputs, one fed from
//    each side, and sits right of its A-side device.
//  - A new feeder (with its breaker) or transformer goes on a new row below
//    everything else.
//
// New boxes are copies of boxes of the same type already in the diagram, so
// they carry exactly the archive shape the project's AcSELerator wrote.

const ROW_PITCH = 7;
const GAP = 12; // grid columns between one box's output pin and the next box
const LABELS = {
  // Z/Y side labels under a recloser, where the schemes put them.
  aibo: [['Z', -1, 3], ['Y', 5, 3]],
  aibi: [['Z', -2, 0], ['Y', -2, 4]],
};

const lower = (s) => String(s ?? '').toLowerCase();

function templateBox(cfc, pattern) {
  const tally = new Map();
  for (const el of cfc.boxes()) {
    if (!pattern.test(el.type)) continue;
    tally.set(el.type, [...(tally.get(el.type) ?? []), el]);
  }
  const [best] = [...tally.values()].sort((a, b) => b.length - a.length);
  return best?.[0] ?? null;
}

/** What the wire leaving `pin` reaches, following connection marks by name. */
function wiresFrom(cfc, pin) {
  return cfc.connections.filter((c) => c.src === pin);
}
function reaches(cfc, conn) {
  const own = cfc.pinOwner.get(conn.dst)?.el;
  if (own?.kind !== 'markSink') return [own];
  const sources = cfc.elements.filter((el) => el.kind === 'markSource' && lower(el.name) === lower(own.name));
  return sources.flatMap((src) => wiresFrom(cfc, src.outs[0]).flatMap((c) => reaches(cfc, c)));
}

function bottom(cfc) {
  let y = 0;
  for (const el of cfc.elements) if (el.y != null && el.kind !== 'connection') y = Math.max(y, el.y);
  return y;
}

/**
 * Move everything on the row band of (x, y) at or right of x across by dx,
 * and fix the wires that touch what moved.
 */
function makeRoom(cfc, x, y, dx) {
  const moved = new Set();
  const band = (bx, by) => {
    for (const el of cfc.elements) {
      if (el.kind === 'connection' || el.x == null || moved.has(el)) continue;
      if (el.x >= bx - 1 && el.y >= by - 1 && el.y <= by + 4) moved.add(el);
    }
  };
  band(x, y);
  if (!moved.size) return;
  for (const el of moved) cfc.moveElement(el, dx, 0);
  // A box pushed onto one on a neighbouring row pushes that row along too.
  for (let pass = 0; pass < 50; pass += 1) {
    const hit = cfc.boxes().find((b) => !moved.has(b)
      && [...moved].some((m) => m.kind === 'box' && m !== b && overlapsBox(cfc, m, b)));
    if (!hit) break;
    const before = new Set(moved);
    band(hit.x, hit.y);
    for (const el of moved) if (!before.has(el)) cfc.moveElement(el, dx, 0);
  }
  const isMoved = (pin) => moved.has(cfc.pinOwner.get(pin)?.el);
  for (const conn of [...cfc.connections]) {
    const s = isMoved(conn.src);
    const d = isMoved(conn.dst);
    if (s && d) cfc.shiftRoute(conn.id, dx, 0);
    else if (s || d) {
      const pts = cfc.routePoints(conn.id) ?? [];
      const bend = pts.length > 2 ? pts[1].x + (s ? dx : 0) : undefined;
      cfc.reroute(conn, bend);
    }
  }
}

function overlapsBox(cfc, a, b) {
  const ah = 2 + Math.max(a.ins.length, a.outs.length);
  const bh = 2 + Math.max(b.ins.length, b.outs.length);
  return a.x < b.x + cfc.width(b) && b.x < a.x + cfc.width(a) && a.y < b.y + bh && b.y < a.y + ah;
}

/** Would a box of width w and h pins at (x, y) sit on top of an existing box? */
function occupied(cfc, x, y, w, h) {
  return cfc.boxes().some((b) => {
    const bh = 2 + Math.max(b.ins.length, b.outs.length);
    return x - 1 < b.x + cfc.width(b) + 1 && b.x - 1 < x + w + 1 && y < b.y + bh && b.y < y + 2 + h;
  });
}

/**
 * Where an appended box goes: right of the pin it hangs off, pushing that row
 * along — or, when something on a neighbouring row is in the way, on a new
 * row below everything, wired across.
 */
function appendSpot(cfc, start, template) {
  const w = cfc.width(template);
  const h = Math.max(template.ins.length, template.outs.length);
  const x = start.x + GAP + 1;
  const y = start.y - 2;
  makeRoom(cfc, x, y, w + GAP);
  if (!occupied(cfc, x, y, w, h)) return { x, y };
  return { x, y: bottom(cfc) + ROW_PITCH };
}

function addLabels(cfc, box, layout) {
  for (const [text, dx, dy] of layout) {
    const template = cfc.elements.find((el) => el.kind === 'comment' && el.name === text);
    if (!template) continue;
    cfc.cloneElement(template, { after: box, x: box.x + dx, y: box.y + dy });
  }
}

function newBox(cfc, template, name, x, y, after) {
  const box = cfc.cloneElement(template, { after: after ?? template, x, y });
  cfc.rename(box, name);
  return box;
}

/**
 * A normally-closed recloser between `aSide` and `bSide` (or after `aSide`
 * when it feeds nothing yet, or when bSide is blank and aSide feeds exactly
 * one thing). Returns a description of where it went, or throws a message.
 */
function insertRecloser(cfc, { name, aSide, bSide }) {
  const template = templateBox(cfc, /^DA_REC\.AiBo$/i);
  if (!template) throw new Error('the AreaMap has no DA_REC.AiBo box to copy');
  const from = cfc.box(aSide);
  if (!from) throw new Error(`no ${aSide} on the AreaMap`);
  const out = from.outs[0];
  if (!out) throw new Error(`${from.name} has no output to wire from`);
  const wires = wiresFrom(cfc, out);
  let cut = null;
  if (bSide) {
    const to = cfc.box(bSide);
    if (!to) throw new Error(`no ${bSide} on the AreaMap`);
    cut = wires.find((c) => reaches(cfc, c).includes(to));
    if (!cut) throw new Error(`${from.name} is not wired to ${to.name}`);
  } else if (wires.length === 1) {
    cut = wires[0];
  } else if (wires.length > 1) {
    const names = [...new Set(wires.flatMap((c) => reaches(cfc, c)).map((el) => el?.name).filter(Boolean))];
    throw new Error(`${from.name} feeds ${names.join(', ')}; give the B side`);
  }
  const width = cfc.width(template);
  if (cut) {
    const end = cfc.pinPoint(cut.dst);
    const target = cfc.pinOwner.get(cut.dst).el;
    const x = end.x + 1;
    const y = end.y - 2;
    const path = cfc.routePoints(cut.id);
    makeRoom(cfc, x, y, width + GAP);
    const box = newBox(cfc, template, name, x, y, from);
    addLabels(cfc, box, LABELS.aibo);
    // The cut wire keeps its drawn path; it now ends where the new box's A
    // pin sits, exactly where the moved device's pin was.
    const dst = cut.dst;
    cfc.setDestination(cut, box.ins[0]);
    if (path) cfc.setRoute(cut.id, path);
    cfc.connect(box.outs[0], dst);
    return `between ${from.name} and ${target.name}`;
  }
  const { x, y } = appendSpot(cfc, cfc.pinPoint(out), template);
  const box = newBox(cfc, template, name, x, y, from);
  addLabels(cfc, box, LABELS.aibo);
  cfc.connect(out, box.ins[0]);
  return `after ${from.name}`;
}

/** A normally-open recloser fed from `aSide` and, if given, `bSide`. */
function insertTie(cfc, { name, aSide, bSide }) {
  const template = templateBox(cfc, /^DA_REC\.AiBi$/i);
  if (!template) throw new Error('the AreaMap has no DA_REC.AiBi box to copy');
  const from = cfc.box(aSide);
  if (!from) throw new Error(`no ${aSide} on the AreaMap`);
  const other = bSide ? cfc.box(bSide) : null;
  if (bSide && !other) throw new Error(`no ${bSide} on the AreaMap`);
  const start = cfc.pinPoint(from.outs[0]);
  if (!start) throw new Error(`${from.name} has no output to wire from`);
  const { x, y } = appendSpot(cfc, start, template);
  const box = newBox(cfc, template, name, x, y, from);
  addLabels(cfc, box, LABELS.aibi);
  cfc.connect(from.outs[0], box.ins[0]);
  if (other) {
    if (!other.outs[0]) throw new Error(`${other.name} has no output to wire from`);
    cfc.connect(other.outs[0], box.ins[1]);
    return `tie between ${from.name} and ${other.name}`;
  }
  return `tie after ${from.name}`;
}

/**
 * A connector (DA_DAC_INTERCONNECT.Bo) feeding the tie `feeds` on its free
 * input: below-left of a B input with an L-shaped wire, left of an A input
 * with a straight one, where the schemes draw them.
 */
function insertConnector(cfc, { name, feeds }) {
  const template = templateBox(cfc, /INTERCONNECT\.Bo$/i);
  if (!template) throw new Error('the AreaMap has no DA_DAC_INTERCONNECT box to copy');
  if (!feeds) throw new Error('give the tie it feeds');
  const tie = cfc.box(feeds);
  if (!tie) throw new Error(`no ${feeds} on the AreaMap`);
  const used = new Set(cfc.connections.map((c) => c.dst));
  const free = tie.ins.map((pin, i) => ({ pin, i })).filter(({ pin }) => !used.has(pin));
  const slot = free.find(({ i }) => i === 1) ?? free[0];
  if (!slot) throw new Error(`${tie.name} has no free input`);
  const pin = cfc.pinPoint(slot.pin);
  const w = cfc.width(template);
  const drop = slot.i === 1 ? 4 : 0;
  let x = pin.x - 5 - w;
  let y = pin.y + drop - 2;
  for (let tries = 0; occupied(cfc, x, y, w, 1) && tries < 8; tries += 1) y += slot.i === 1 ? 2 : -2;
  if (occupied(cfc, x, y, w, 1)) { x = pin.x - 5 - w; y = bottom(cfc) + ROW_PITCH; }
  const box = newBox(cfc, template, name, x, y, tie);
  cfc.connect(box.outs[0], slot.pin);
  return `feeding ${tie.name}`;
}

/** Column offset from a box of type `fromType` to the box it feeds of type `toType`. */
function learnedOffset(cfc, fromType, toType) {
  const tally = new Map();
  for (const conn of cfc.connections) {
    const a = cfc.pinOwner.get(conn.src)?.el;
    const b = cfc.pinOwner.get(conn.dst)?.el;
    if (a?.kind !== 'box' || b?.kind !== 'box' || a.y !== b.y) continue;
    if (!fromType.test(a.type) || !toType.test(b.type)) continue;
    const dx = b.x - a.x;
    tally.set(dx, (tally.get(dx) ?? 0) + 1);
  }
  return [...tally].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;
}

function modeX(boxes) {
  const tally = new Map();
  for (const b of boxes) tally.set(b.x, (tally.get(b.x) ?? 0) + 1);
  return [...tally].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 5;
}

const FEEDER = /^DA_FDR\./i;
const XFMR = /^DA_SUB_TRANSFORMER\./i;
const PSEUDO = /^DA_PSEUDO_BKR\.AiBo$/i;
const REC = /^DA_REC\.AiBo$/i;

/** A new transformer on its own row. */
function insertTransformer(cfc, { name }) {
  const template = templateBox(cfc, XFMR);
  if (!template) throw new Error('the AreaMap has no DA_SUB_TRANSFORMER box to copy');
  const x = modeX(cfc.boxes().filter((b) => XFMR.test(b.type)));
  newBox(cfc, template, name, x, bottom(cfc) + ROW_PITCH, null);
  return 'new row';
}

/**
 * A new feeder and its breaker. A 13.2kV feeder (DA_FDR.AiBo) hangs off its
 * transformer `aSide`; a 34.5kV one (DA_FDR.Bo) is a source of its own.
 */
function insertFeeder(cfc, { name, aSide, breaker }) {
  const template = templateBox(cfc, FEEDER);
  if (!template) throw new Error('the AreaMap has no DA_FDR box to copy');
  const fed = template.ins.length > 0;
  let source = null;
  if (fed) {
    if (!aSide) throw new Error('give the transformer it hangs off (A side)');
    source = cfc.box(aSide);
    if (!source) throw new Error(`no ${aSide} on the AreaMap`);
  }
  let x;
  let y = bottom(cfc) + ROW_PITCH;
  if (source) {
    x = source.x + (learnedOffset(cfc, XFMR, FEEDER) ?? (cfc.width(source) + 3));
    // The first feeder of a transformer sits on its row.
    if (!wiresFrom(cfc, source.outs[0]).length) y = source.y;
  } else {
    x = modeX(cfc.boxes().filter((b) => FEEDER.test(b.type)));
  }
  const fdr = newBox(cfc, template, name, x, y, source);
  let where = 'new row';
  if (source) {
    const from = cfc.pinPoint(source.outs[0]);
    cfc.connect(source.outs[0], fdr.ins[0], undefined);
    if (from.y !== fdr.y + 2) where = `new row, wired from ${source.name}`;
    else where = `beside ${source.name}`;
  }
  if (breaker) {
    const pattern = breaker.kind === 'pseudo' ? PSEUDO : REC;
    const bt = templateBox(cfc, pattern);
    if (!bt) throw new Error(`the AreaMap has no ${breaker.kind === 'pseudo' ? 'DA_PSEUDO_BKR' : 'DA_REC.AiBo'} box to copy`);
    const dx = learnedOffset(cfc, FEEDER, pattern) ?? (cfc.width(fdr) + 3);
    const bkr = newBox(cfc, bt, breaker.name, fdr.x + dx, fdr.y, fdr);
    cfc.connect(fdr.outs[0], bkr.ins[0]);
  }
  return where;
}

/**
 * Place every request, in order (so a recloser can hang off a feeder or
 * another recloser placed just before it). Returns { placed, problems }.
 */
function placeOnAreaMap(cfc, requests) {
  const placed = [];
  const problems = [];
  // A device that hangs off another new one waits until that one is placed,
  // whatever order the rows came in.
  const names = new Set(requests.map((req) => lower(req.name)));
  const waitsOn = (req) => [req.aSide, req.bSide, req.feeds]
    .some((n) => n && names.has(lower(n)) && !cfc.box(n));
  let queue = requests.filter((req) => {
    if (!cfc.box(req.name)) return true;
    problems.push({ device: req.name, message: 'already on the AreaMap; left as is' });
    return false;
  });
  while (queue.length) {
    const req = queue.find((r) => !waitsOn(r)) ?? queue[0];
    queue = queue.filter((r) => r !== req);
    try {
      let where;
      if (req.kind === 'transformer') where = insertTransformer(cfc, req);
      else if (req.kind === 'feeder') where = insertFeeder(cfc, req);
      else if (req.kind === 'connector') where = insertConnector(cfc, req);
      else if (!req.aSide) throw new Error('no A side given');
      else if (req.open) where = insertTie(cfc, req);
      else where = insertRecloser(cfc, req);
      placed.push({ name: req.name, where });
    } catch (err) {
      problems.push({ device: req.name, message: `not placed on the AreaMap: ${err.message}` });
    }
    names.delete(lower(req.name));
  }
  cfc.fitCanvas();
  return { placed, problems };
}

/** Does feeder `name` feed anything past its own breaker? */
function hasDownline(cfc, name, breakerName) {
  const fdr = cfc.box(name);
  if (!fdr) return null;
  const skip = lower(breakerName);
  const seen = new Set();
  const stack = [fdr];
  while (stack.length) {
    const el = stack.pop();
    for (const pin of el.outs) {
      for (const conn of wiresFrom(cfc, pin)) {
        for (const next of reaches(cfc, conn)) {
          if (!next || seen.has(next)) continue;
          seen.add(next);
          if (lower(next.name) !== skip) return true;
          stack.push(next);
        }
      }
    }
  }
  return false;
}

export { placeOnAreaMap, hasDownline };
