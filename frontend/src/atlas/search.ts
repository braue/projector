import type { Doc } from './content'
import { DOCS } from './content'

export interface Hit {
  doc: Doc
  score: number
  snippet: string
}

/** All query terms must appear somewhere in the doc (title, tags, or body). */
export function search(query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
  if (terms.length === 0) return []

  const hits: Hit[] = []
  for (const doc of DOCS) {
    const title = doc.title.toLowerCase()
    const tags = doc.tags.join(' ').toLowerCase()
    let score = 0
    let ok = true
    for (const term of terms) {
      const inTitle = title.includes(term)
      const inTags = tags.includes(term)
      let bodyCount = 0
      let idx = doc.text.indexOf(term)
      while (idx !== -1 && bodyCount < 50) {
        bodyCount++
        idx = doc.text.indexOf(term, idx + term.length)
      }
      if (!inTitle && !inTags && bodyCount === 0) { ok = false; break }
      score += (inTitle ? 12 : 0) + (inTags ? 6 : 0) + Math.min(bodyCount, 10)
    }
    if (ok) hits.push({ doc, score, snippet: makeSnippet(doc, terms) })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits
}

function makeSnippet(doc: Doc, terms: string[]): string {
  const text = doc.text
  const shown = doc.plain.length === text.length ? doc.plain : text
  let pos = -1
  for (const term of terms) {
    const i = text.indexOf(term)
    if (i !== -1 && (pos === -1 || i < pos)) pos = i
  }
  if (pos === -1) return doc.summary || text.slice(0, 130)
  const start = Math.max(0, pos - 55)
  const end = Math.min(text.length, pos + 95)
  return (start > 0 ? '…' : '') + shown.slice(start, end) + (end < text.length ? '…' : '')
}

/** Split a snippet into parts, marking those that match any term (for <mark> rendering). */
export function highlightParts(snippet: string, query: string): { text: string; hit: boolean }[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
  if (terms.length === 0) return [{ text: snippet, hit: false }]
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  return snippet.split(re).filter((s) => s.length > 0).map((s) => ({
    text: s,
    hit: terms.includes(s.toLowerCase()),
  }))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
