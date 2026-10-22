import { useCallback, useEffect, useRef, useState } from 'react'

import { saveSettingSoon, setting } from './settings'

// Drag-to-resize width for a vertical pane. One settings key per pane
// kind, so panes of the same kind (the left sidebar in the project and the
// tools, the item tree across inspect/compare/aggregate) share a width that
// survives restarts.

interface PaneConfig {
  min: number
  max: number
  fallback: number
}

function usePaneWidth(key: string, { min, max, fallback }: PaneConfig) {
  const [width, setWidth] = useState(() => {
    const stored = setting<unknown>(key, null)
    return typeof stored === 'number' && stored >= min && stored <= max ? stored : fallback
  })

  // Only a drag is worth remembering — saving the untouched default would pin
  // it against a future default change.
  const initial = useRef(width)
  useEffect(() => {
    if (width !== initial.current && width !== setting(key, null)) saveSettingSoon(key, width)
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

/** The left sidebar: the project tree, and the tools list. */
export function useSidebarWidth() {
  return usePaneWidth('sidebarWidth', { min: 180, max: 560, fallback: 224 })
}

/** The item tree pane (browse, compare, and aggregate all share it). */
export function useTreePaneWidth() {
  return usePaneWidth('treePaneWidth', { min: 220, max: 680, fallback: 320 })
}
