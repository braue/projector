import { useCallback, useEffect, useState } from 'react'

// Drag-to-resize width for the left source rail. One localStorage key, so
// the canvas/inspect sidebar and the compare rail share a width and it
// survives reloads.

const KEY = 'purview-sidebar-width'
const MIN = 180
const MAX = 560
const DEFAULT_WIDTH = 224

const clamp = (value: number) => Math.min(Math.max(value, MIN), MAX)

export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(KEY))
    return Number.isFinite(stored) && stored >= MIN && stored <= MAX ? stored : DEFAULT_WIDTH
  })

  useEffect(() => {
    localStorage.setItem(KEY, String(width))
  }, [width])

  /** Mousedown handler for the rail's right-edge grip. */
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
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
    [width],
  )

  return { width, startResize }
}
