// Which folders of a project's tree are open. It rides sessionStorage per
// project: switching panes or projects doesn't re-collapse an exploration
// mid-session — only a fresh app start does (folders start collapsed at
// launch).

import { useEffect, useRef, useState } from 'react'

const expandedKey = (project: string) => `projector.tree-expanded:${project}`

function loadExpanded(project: string): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(expandedKey(project)) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((p) => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

export function useExpanded(project: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(project))
  const expandedFor = useRef(project)
  if (expandedFor.current !== project) {
    // Project switched without a remount: swap in that project's set.
    expandedFor.current = project
    setExpanded(loadExpanded(project))
  }
  useEffect(() => {
    try {
      sessionStorage.setItem(expandedKey(project), JSON.stringify([...expanded]))
    } catch {
      // Persistence is best-effort; expansion still works for this render.
    }
  }, [project, expanded])

  /** Open or close one folder. */
  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  // Anything that PUTS something into a folder opens the path to it, so the
  // result is on screen. Called on SUCCESS (an upload that lands, an export
  // that completes, a move) — not on intent, so a cancelled dialog doesn't
  // leave folders open. The inline create forms are the exception: they
  // render inside the folder, which must be open for them to show at all.
  const reveal = (dir: string) => {
    if (!dir) return
    setExpanded((current) => {
      const next = new Set(current)
      let acc = ''
      for (const part of dir.split('/')) {
        acc = acc ? `${acc}/${part}` : part
        next.add(acc)
      }
      return next
    })
  }

  return { expanded, toggle, reveal }
}
