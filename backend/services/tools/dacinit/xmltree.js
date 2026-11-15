// A round-trip-exact XML tree for surgical edits to AcSELerator exports. The
// shared parser (lib/parsers/xml.js) builds plain objects and loses layout;
// the CFC diagrams and tag lists edited here have to come back byte-for-byte
// identical wherever nothing changed, so this keeps every tag and every run of
// text exactly as read, and serializes by concatenation.
//
// A node is { open, close, children, parent } where `open` is the start tag
// as written ('<Single Name="Id" Type="long">'), `close` the end tag ('' for a
// self-closing one) and `children` a mix of strings (text, comments, CDATA)
// and nodes. Only the shapes AcSELerator writes are handled: no DTDs, no
// processing instructions past the prolog.

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
})[e]);
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parse(text) {
  const root = { open: '', close: '', children: [], parent: null };
  let node = root;
  let i = 0;
  const pushText = (s) => {
    if (!s) return;
    const last = node.children[node.children.length - 1];
    if (typeof last === 'string') node.children[node.children.length - 1] = last + s;
    else node.children.push(s);
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { pushText(text.slice(i)); break; }
    pushText(text.slice(i, lt));
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt) + 3;
      pushText(text.slice(lt, end));
      i = end;
    } else if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt) + 3;
      pushText(text.slice(lt, end));
      i = end;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt) + 2;
      pushText(text.slice(lt, end));
      i = end;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt) + 1;
      node.close = text.slice(lt, end);
      node = node.parent;
      i = end;
    } else {
      // Attribute values never hold '>' in these exports (they're encoded).
      const end = text.indexOf('>', lt) + 1;
      const open = text.slice(lt, end);
      const child = { open, close: '', children: [], parent: node };
      node.children.push(child);
      if (!open.endsWith('/>')) node = child;
      i = end;
    }
  }
  return root;
}

function serialize(node) {
  let out = node.open;
  for (const child of node.children) out += typeof child === 'string' ? child : serialize(child);
  return out + node.close;
}

const tagName = (node) => /^<([\w:.-]+)/.exec(node.open)?.[1] ?? null;
function attr(node, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(node.open);
  return m ? decode(m[1]) : null;
}
const elements = (node) => node.children.filter((c) => typeof c !== 'string');

/** The child element carrying Name="…" (the archive's field names). */
function field(node, name) {
  return elements(node).find((c) => attr(c, 'Name') === name) ?? null;
}
/** First child element with this tag name. */
function child(node, tag) {
  return elements(node).find((c) => tagName(c) === tag) ?? null;
}

/** A leaf's text, decoded ('' for an empty or self-closing one). */
function textOf(node) {
  if (!node) return null;
  return decode(node.children.filter((c) => typeof c === 'string').join(''));
}
function setText(node, value) {
  if (node.open.endsWith('/>')) {
    node.open = node.open.replace(/\s*\/>$/, '>');
    node.close = `</${tagName(node)}>`;
  }
  node.children = [encode(value)];
}

/** The archive type GUID of a <Single Type="{…}">, lowercased, or null. */
function typeGuid(node) {
  return /Type="\{([0-9a-fA-F-]+)\}"/.exec(node.open)?.[1].toLowerCase() ?? null;
}

function clone(node, parent = null) {
  const copy = { open: node.open, close: node.close, children: [], parent };
  copy.children = node.children.map((c) => (typeof c === 'string' ? c : clone(c, copy)));
  return copy;
}

/** Every descendant element (depth first), including `node`. */
function* walk(node) {
  yield node;
  for (const c of elements(node)) yield* walk(c);
}

/**
 * Insert `nodes` into `parent` after `after` (or at the end), each on its own
 * line with the indentation its siblings use.
 */
function insertAfter(parent, after, nodes) {
  const indent = siblingIndent(parent);
  let at = after ? parent.children.indexOf(after) + 1 : lastElementIndex(parent) + 1;
  for (const n of nodes) {
    n.parent = parent;
    parent.children.splice(at, 0, `\n${indent}`, n);
    at += 2;
  }
}

function lastElementIndex(parent) {
  for (let i = parent.children.length - 1; i >= 0; i -= 1) {
    if (typeof parent.children[i] !== 'string') return i;
  }
  // An empty list: its newline-and-indent comes before the closing tag.
  return -1;
}

function siblingIndent(parent) {
  for (let i = 0; i < parent.children.length; i += 1) {
    const c = parent.children[i];
    if (typeof c !== 'string' && i > 0 && typeof parent.children[i - 1] === 'string') {
      return parent.children[i - 1].split('\n').pop();
    }
  }
  // No element children yet: one level deeper than the parent's own line.
  const before = parent.parent?.children[parent.parent.children.indexOf(parent) - 1];
  const own = typeof before === 'string' ? before.split('\n').pop() : '';
  return `${own}  `;
}

/** Remove `node` and the whitespace that introduces it. */
function remove(node) {
  const parent = node.parent;
  const i = parent.children.indexOf(node);
  const before = parent.children[i - 1];
  if (typeof before === 'string' && /^\s*$/.test(before.split('\n').pop()) && before.includes('\n')) {
    const cut = before.lastIndexOf('\n');
    const rest = before.slice(0, cut);
    if (rest) parent.children.splice(i - 1, 2, rest);
    else parent.children.splice(i - 1, 2);
  } else {
    parent.children.splice(i, 1);
  }
  node.parent = null;
}

/** Re-indent a cloned subtree that moves `delta` spaces deeper (or shallower). */
function reindent(node, delta) {
  if (!delta) return;
  const fix = (s) => s.replace(/\n( *)/g, (_, sp) => `\n${' '.repeat(Math.max(0, sp.length + delta))}`);
  for (const n of walk(node)) {
    n.children = n.children.map((c) => (typeof c === 'string' && !c.startsWith('<![CDATA[') ? fix(c) : c));
  }
}

export {
  parse, serialize, tagName, attr, elements, field, child, textOf, setText, typeGuid,
  clone, walk, insertAfter, remove, reindent, encode, decode,
};
