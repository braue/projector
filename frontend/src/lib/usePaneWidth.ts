import { useCallback, useEffect, useState } from 'react'

// Drag-to-resize width for a vertical pane. One localStorage key per pane
// kind, so panes of the same kind (the source rail across modes, the tree
// pane across browse/compare/aggregate) share a width that survives reloads.

interface PaneConfig {
  min: number
  max: number
  fallback: number
}

function usePaneWidth(key: string, { min, max, fallback }: PaneConfig) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(key))
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback
  })

  useEffect(() => {
    localStorage.setItem(key, String(width))
  }, [key, width])

  /** Mousedown handler for the pane's right-edge grip. */
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      const clamp = (value: number) => Math.min(Math.max(value, min), max)
      const move = (ev: MouseEvent) => setWidth(clamp(startWidth + ev.clientX - startX))
      const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
      document.body.style.cursor = 'col-resize'
    },
    [width, min, max],
  )

  return { width, startResize }
}

/** The left source rail (canvas/inspect sidebar and the compare rail). */
export function useSidebarWidth() {
  return usePaneWidth('projector-sidebar-width', { min: 180, max: 560, fallback: 224 })
}

/** The item tree pane (browse, compare, and aggregate all share it). */
export function useTreePaneWidth() {
  return usePaneWidth('projector-tree-width', { min: 220, max: 680, fallback: 320 })
}
