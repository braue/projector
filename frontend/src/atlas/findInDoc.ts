// Find-in-page for an open atlas document — the Ctrl+F the sidebar's
// cross-document search cannot stand in for. The browser's own find bar is
// no help here: HTML guides render inside an iframe, so a native find run
// from the shell never reaches their text (and, in the desktop build, there
// is no native find bar at all).
//
// Matching is plain case-insensitive substring against text nodes, so a hit
// that straddles an element boundary ("<b>DNP</b>3") is missed — the same
// trade every lightweight in-page find makes. Hits are wrapped in <mark>
// rather than painted through the Highlight API because the marks have to
// live in the iframe's document, where scrollIntoView needs an element.

const MARK_CLASS = 'atl-find-hit'
const ON_CLASS = 'on'

/** Text under these never counts as page content. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT'])

/** Undo a pass: every mark we made collapses back into its text. Safe to
 *  call on a root that was never marked, or on none at all. */
export function clearFind(root: HTMLElement | null | undefined): void {
  if (!root) return
  for (const mark of [...root.querySelectorAll(`mark.${MARK_CLASS}`)]) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(
      (mark.ownerDocument ?? document).createTextNode(mark.textContent ?? ''),
      mark,
    )
    // Re-join the split halves, so a second pass sees whole words again.
    parent.normalize()
  }
}

/** Wrap every match in `root`, in document order, and hand back the marks. */
export function markFind(root: HTMLElement, query: string): HTMLElement[] {
  clearFind(root)
  const needle = query.toLowerCase()
  if (!needle) return []
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT
      return (node.nodeValue ?? '').toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    },
  })

  // Collect first, split second: splitting mid-walk would have the walker
  // stepping through nodes that no longer exist.
  const targets: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push(node as Text)
  }

  const hits: HTMLElement[] = []
  for (const text of targets) {
    let rest = text
    let at = (rest.nodeValue ?? '').toLowerCase().indexOf(needle)
    while (at >= 0) {
      const match = rest.splitText(at)
      const tail = match.splitText(needle.length)
      const mark = doc.createElement('mark')
      mark.className = MARK_CLASS
      match.parentNode?.replaceChild(mark, match)
      mark.appendChild(match)
      hits.push(mark)
      rest = tail
      at = (rest.nodeValue ?? '').toLowerCase().indexOf(needle)
    }
  }
  return hits
}

/** Make `index` the current hit: it alone carries the strong highlight, and
 *  the page scrolls to it (the iframe's own smooth scrolling applies). */
export function focusHit(hits: HTMLElement[], index: number): void {
  hits.forEach((hit, i) => hit.classList.toggle(ON_CLASS, i === index))
  hits[index]?.scrollIntoView({ block: 'center' })
}
