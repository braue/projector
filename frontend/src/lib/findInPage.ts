// Find-in-page: the Ctrl+F the desktop build does not get for free.
//
// Electron has no native find bar, and half of what projector shows cannot be
// reached by a browser's find anyway — atlas guides render inside an iframe.
// So the app carries its own, and this is its engine: text in, DOM Ranges out.
//
// Two decisions make it work where the obvious version does not:
//
//   - MATCHING RUNS ON THE FLATTENED TEXT of the whole root, not per text
//     node. "Armed feeders" is a match even when only "Armed" is bold, and a
//     phrase that wraps across a line break still matches a typed space —
//     whitespace collapses on both sides. A per-node scan misses both, and
//     those are exactly the phrases people type.
//   - HITS ARE PAINTED WITH THE CSS CUSTOM HIGHLIGHT API, not by wrapping
//     matches in <mark>. Splitting text nodes under React's feet is how you
//     get "failed to execute removeChild" the next time the pane renders, and
//     the settings panes re-render constantly. Highlights are ranges held
//     beside the DOM, so nothing is touched.
//
// Everything takes the root (or its document) as a parameter: the same engine
// drives the main document and the atlas iframe, which is a document of its
// own with its own highlight registry.

/** Highlight registry names; the CSS lives with each surface's styles. */
const ALL = 'pj-find'
const ACTIVE = 'pj-find-on'

/** Text under these never counts as page content. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION'])

/**
 * Tags that do NOT separate words. Everything else does — a table cell, a
 * list item, a line of code — because the DOM puts no character between
 * `<td>Alpha</td><td>Beta</td>` and the reader sees two words. Without this
 * the flattened text says "alphabeta": "alpha beta" would not match and
 * "alphabeta" wrongly would. Inline tags must stay joined for the opposite
 * reason: `<b>DNP</b>3` is the word DNP3.
 */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I',
  'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
  'TIME', 'U', 'VAR', 'WBR',
])

/** Runaway guard: past this, a one-character query is a hang, not a search.
 *  The bar says so, rather than quietly claiming a round number of hits. */
export const HIT_CAP = 2000

/**
 * A run of the flattened text that maps one-for-one onto one text node — so
 * a position in the search string becomes (node, offset) by subtraction.
 * Runs break at node boundaries and wherever whitespace collapsed.
 */
interface Run {
  /** Where this run starts in the flattened text. */
  from: number
  length: number
  node: Text
  /** Where this run starts inside that node. */
  at: number
}

interface Flat {
  /** Lowercased, whitespace-collapsed text of the whole root. */
  text: string
  runs: Run[]
}

function isHidden(el: Element): boolean {
  return (
    SKIP_TAGS.has(el.tagName) ||
    (el as HTMLElement).hidden === true ||
    // Decorative text the reader does not read — the code gutter's line
    // numbers, above all. Marking it hidden for screen readers marks it
    // hidden for find, which is the same judgement twice.
    el.getAttribute('aria-hidden') === 'true'
  )
}

/**
 * Every visible text node under `root`, lowercased and whitespace-collapsed
 * into one string, with the runs that map it back to the DOM.
 *
 * The walk is by hand rather than through a TreeWalker because where the
 * ELEMENTS begin and end is half the information: block boundaries become
 * spaces, inline ones do not.
 *
 * The chunking is deliberate too: a settings sheet with every row shown is
 * two million characters, and anything that touches each of them
 * individually (a regex test per character, an array entry per character)
 * turns a keystroke into a second of frozen UI. Slicing between whitespace
 * runs keeps the per-character work inside the engine's own string
 * primitives.
 */
function flatten(root: HTMLElement): Flat {
  const parts: string[] = []
  const runs: Run[] = []
  let length = 0
  let endsInSpace = true // leading whitespace collapses away entirely
  let last: { node: Text; end: number } | null = null

  const push = (text: string, node: Text, at: number) => {
    const lower = text.toLowerCase()
    // A case fold that changes length (İ, ﬁ, …) would slide every offset
    // after it; those chunks keep their original case rather than lie.
    const piece = lower.length === text.length ? lower : text
    parts.push(piece)
    runs.push({ from: length, length: piece.length, node, at })
    length += piece.length
    endsInSpace = false
    last = { node, end: at + text.length }
  }

  /** One space, mapped at `node`/`at`, unless there already is one. */
  const pushSpace = (node: Text, at: number) => {
    if (endsInSpace) return
    parts.push(' ')
    runs.push({ from: length, length: 1, node, at })
    length += 1
    endsInSpace = true
  }

  /** A block boundary reads as a space; it belongs to the text that ended. */
  const pushBreak = () => {
    if (last) pushSpace(last.node, last.end)
  }

  const space = /\s+/g
  const visit = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const node = child as Text
        const value = node.nodeValue ?? ''
        if (!value) continue
        space.lastIndex = 0
        let pos = 0
        for (let run = space.exec(value); run; run = space.exec(value)) {
          if (run.index > pos) push(value.slice(pos, run.index), node, pos)
          // A run of whitespace — newlines and indentation included — reads
          // as the single space the user typed, and answers to the DOM
          // position of its first character.
          pushSpace(node, run.index)
          pos = run.index + run[0].length
        }
        if (pos < value.length) push(value.slice(pos), node, pos)
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      if (isHidden(el)) continue
      if (el.tagName === 'BR') {
        pushBreak()
        continue
      }
      const inline = INLINE_TAGS.has(el.tagName)
      if (!inline) pushBreak()
      visit(el)
      if (!inline) pushBreak()
    }
  }
  visit(root)

  return { text: parts.join(''), runs }
}

/** The run holding flattened position `at` — binary search; a full sheet is
 *  hundreds of thousands of runs. */
function runAt(runs: Run[], at: number): Run | null {
  let low = 0
  let high = runs.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const run = runs[mid]
    if (at < run.from) high = mid - 1
    else if (at >= run.from + run.length) low = mid + 1
    else return run
  }
  return null
}

/** The same normalization the flattened text got, so a query typed with odd
 *  spacing still lines up against it. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Every match of `query` under `root`, in document order, as live Ranges.
 * An empty or whitespace-only query matches nothing (rather than everything).
 */
export function findRanges(root: HTMLElement | null | undefined, query: string): Range[] {
  if (!root) return []
  const needle = normalizeQuery(query)
  if (!needle) return []

  const { text, runs } = flatten(root)
  const doc = root.ownerDocument
  const ranges: Range[] = []
  let at = text.indexOf(needle)
  while (at >= 0 && ranges.length < HIT_CAP) {
    // The LAST matched character, not the one after it: a match that ends at
    // a collapsed space ends inside the node that space came from.
    const first = runAt(runs, at)
    const last = runAt(runs, at + needle.length - 1)
    if (first && last) {
      const range = doc.createRange()
      range.setStart(first.node, first.at + (at - first.from))
      range.setEnd(last.node, last.at + (at + needle.length - 1 - last.from) + 1)
      ranges.push(range)
    }
    at = text.indexOf(needle, at + needle.length)
  }
  return ranges
}

/** The highlight registry of whichever document `doc` is — the main one or
 *  an iframe's. Null when the engine is not available (no highlights, no
 *  crash: stepping through hits still scrolls to them). */
function registry(doc: Document | null | undefined) {
  const view = doc?.defaultView as (typeof globalThis) | null | undefined
  if (!view?.CSS?.highlights || typeof view.Highlight !== 'function') return null
  return { highlights: view.CSS.highlights, Highlight: view.Highlight }
}

/** Paint `ranges` in `doc`, with `active` carrying the strong highlight. */
export function paintHits(doc: Document, ranges: Range[], active: number): void {
  const api = registry(doc)
  if (!api) return
  if (!ranges.length) {
    api.highlights.delete(ALL)
    api.highlights.delete(ACTIVE)
    return
  }
  api.highlights.set(ALL, new api.Highlight(...ranges))
  const current = ranges[active]
  if (current) api.highlights.set(ACTIVE, new api.Highlight(current))
  else api.highlights.delete(ACTIVE)
}

/** Drop every highlight this module set in `doc`. Safe on a document that
 *  never had any. */
export function clearHits(doc: Document | null | undefined): void {
  const api = registry(doc)
  if (!api) return
  api.highlights.delete(ALL)
  api.highlights.delete(ACTIVE)
}

/** The nearest ancestor that actually scrolls, or the document's scroller. */
function scroller(el: Element): Element | null {
  const doc = el.ownerDocument
  const view = doc.defaultView
  for (let node: Element | null = el; node && node !== doc.body; node = node.parentElement) {
    const style = view?.getComputedStyle(node)
    const overflow = `${style?.overflowY ?? ''} ${style?.overflowX ?? ''}`
    if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 1) return node
  }
  return doc.scrollingElement
}

/**
 * Bring a hit into view — vertically centred, and horizontally too, since a
 * match can sit in the far-right column of a settings sheet that scrolls
 * sideways. Ranges have no scrollIntoView of their own, so this works off the
 * rectangles: same document for both, so they share an origin.
 */
export function revealRange(range: Range): void {
  const start = range.startContainer
  const el = start.nodeType === Node.TEXT_NODE ? start.parentElement : (start as Element)
  if (!el) return
  const box = scroller(el)
  const doc = el.ownerDocument
  const hit = range.getBoundingClientRect()
  if (!box) {
    el.scrollIntoView({ block: 'center' })
    return
  }
  // The document scroller's own rect is the whole content box, not the
  // viewport it scrolls inside; every other element's rect is the viewport.
  const isRoot = box === doc.scrollingElement
  const top = isRoot ? 0 : box.getBoundingClientRect().top
  const left = isRoot ? 0 : box.getBoundingClientRect().left
  const height = isRoot ? (doc.defaultView?.innerHeight ?? box.clientHeight) : box.clientHeight
  const width = isRoot ? (doc.defaultView?.innerWidth ?? box.clientWidth) : box.clientWidth

  if (hit.top < top + 8 || hit.bottom > top + height - 8) {
    box.scrollTop += hit.top - top - height / 2 + hit.height / 2
  }
  if (hit.left < left + 8 || hit.right > left + width - 8) {
    box.scrollLeft += hit.left - left - width / 2 + hit.width / 2
  }
}
