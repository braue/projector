// What the tree has picked: the SELECTED path (the one the right pane shows —
// a live entry or an archived version), rows HELD alongside it with
// ctrl/shift+click (bulk actions act on all of them; two of one kind offer
// Compare), and — only once asked for from the context menu — the COMPARE
// pair being viewed. A plain click is a fresh single selection: anything
// held and any open comparison follow the click away.

import { useCallback, useState } from 'react'

export function useTreeSelection() {
  const [selected, setSelected] = useState<string | null>(null)
  const [held, setHeld] = useState<string[]>([])
  const [comparePair, setComparePair] = useState<{ original: string; updated: string } | null>(null)

  const select = useCallback((path: string | null) => {
    setSelected(path)
    setHeld([])
    setComparePair(null)
  }, [])

  // Ctrl/cmd-click: hold (or let go of) one more row. Letting go of the
  // selected row itself hands the right pane to the next held one.
  const toggleHeld = useCallback((path: string) => {
    setComparePair(null)
    if (path === selected) {
      setSelected(held[0] ?? null)
      setHeld(held.slice(1))
      return
    }
    if (selected === null) {
      setSelected(path)
      return
    }
    setHeld(held.includes(path) ? held.filter((p) => p !== path) : [...held, path])
  }, [selected, held])

  // Shift-click: hold exactly this range alongside the selection.
  const holdRange = useCallback((paths: string[]) => {
    setComparePair(null)
    setHeld(paths.filter((p) => p !== selected))
  }, [selected])

  const compare = useCallback((original: string, updated: string) => {
    setComparePair({ original, updated })
  }, [])

  return {
    selected, held, comparePair,
    select, toggleHeld, holdRange, compare,
    swapCompare: () => setComparePair((pair) => pair && { original: pair.updated, updated: pair.original }),
    clearCompare: () => setComparePair(null),
  }
}
