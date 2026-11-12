import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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

/** The width a nowrap flex row needs to lay its items out on one line,
 *  whatever width it has now. */
function rowWidth(row: HTMLElement) {
  const style = getComputedStyle(row)
  const items = [...row.children].filter((el) => getComputedStyle(el).position !== 'absolute')
  const gap = parseFloat(style.columnGap) || 0
  return Math.ceil(
    parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      + items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)
      + gap * Math.max(items.length - 1, 0),
  )
}

/** `floor`: finds a row inside the pane that must never wrap — the pane
 *  stops narrowing at that row's width, and widens if the row grows past it. */
function usePaneWidth(key: string, { min, max, fallback }: PaneConfig, floor?: () => HTMLElement | null | undefined) {
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

  const floorWidth = useCallback(() => {
    const row = floor?.()
    return row ? rowWidth(row) : 0
  }, [floor])
  useLayoutEffect(() => {
    const need = floorWidth()
    if (need > width) setWidth(Math.min(need, max))
  })
  // The row can grow without a render: the web font swaps in after the
  // first layout (Windows' fallback is narrower, so the row then overflows
  // the pane), or a count chip appears inside a link. Watch for both.
  useEffect(() => {
    const row = floor?.()
    if (!row) return
    const grow = () => {
      const need = floorWidth()
      setWidth((current) => (need > current ? Math.min(need, max) : current))
    }
    const observer = new ResizeObserver(grow)
    for (const item of row.children) observer.observe(item)
    document.fonts?.addEventListener('loadingdone', grow)
    document.fonts?.ready.then(grow)
    return () => {
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', grow)
    }
  }, [floor, floorWidth, max])

  /** Mousedown handler for the pane's right-edge grip. */
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      const lowest = Math.max(min, floorWidth())
      const clamp = (value: number) => Math.min(Math.max(value, lowest), max)
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
    [width, min, max, floorWidth],
  )

  return { width, startResize }
}

/** The margin: the project, its filter, its tree and the pane links (never
 *  narrower than the links need to sit on one line). Its
 *  own key — the old sidebar width saved before the margin was too narrow
 *  for the project title. */
export function useMarginWidth(margin: React.RefObject<HTMLElement | null>) {
  const nav = useCallback(() => margin.current?.querySelector<HTMLElement>('.margin-nav'), [margin])
  return usePaneWidth('marginWidth', { min: 240, max: 560, fallback: 300 }, nav)
}

/** The tools list. */
export function useSidebarWidth() {
  return usePaneWidth('sidebarWidth', { min: 180, max: 560, fallback: 224 })
}

/** The item tree pane (browse, compare, and aggregate all share it). */
export function useTreePaneWidth() {
  return usePaneWidth('treePaneWidth', { min: 220, max: 680, fallback: 320 })
}
