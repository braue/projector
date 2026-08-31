import { useEffect, useRef } from 'react'

/**
 * Dismissal for a floating panel: a click outside its wrapper closes it, and
 * with `escape`, so does the Escape key. Returns the ref to hang on the
 * wrapper element.
 *
 * Listeners are attached only while the panel is open. `close` is read through
 * a ref so a caller can pass an inline arrow without resubscribing on every
 * render.
 */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  close: () => void,
  { escape = false }: { escape?: boolean } = {},
) {
  const wrap = useRef<T>(null)
  // Latest, so the effect depends on `open` alone.
  const latest = useRef(close)
  latest.current = close

  useEffect(() => {
    if (!open) return
    const clickAway = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) latest.current()
    }
    // An open inline editor stops the key before it reaches here, so Escape
    // finishes that edit first and closes the panel only on a second press.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current()
    }
    document.addEventListener('mousedown', clickAway)
    if (escape) document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', clickAway)
      if (escape) document.removeEventListener('keydown', onEscape)
    }
  }, [open, escape])

  return wrap
}
