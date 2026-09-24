import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { HIT_CAP, clearHits, findRanges, paintHits, revealRange } from '../lib/findInPage'
import { useDebounced } from '../lib/useDebounced'
import { TextInput } from './ui'

// The one find bar. Every pane that can be read — atlas pages, settings
// inspections, comparisons, PDFs — opens the same box in the same corner with
// the same keys, so Ctrl+F means one thing in this app:
//
//   Ctrl+F        open it (again: reselect the term, to type over)
//   Enter / ↓     next hit        Shift+Enter / ↑   previous
//   Esc           close, clearing the highlights
//
// The bar is presentation only. `useFindInPage` drives the ordinary case —
// find words in the DOM of a pane — and the PDF viewer, whose text lives in
// the file rather than the page, supplies its own hits to the same bar.

export function FindBar({
  inputRef,
  term,
  onTerm,
  count,
  onStep,
  onClose,
  placeholder = 'Find in page…',
  actions,
  children,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  term: string
  onTerm: (value: string) => void
  /** "3/48", "none", a spinner — whatever the surface knows. */
  count: ReactNode
  onStep: (delta: number) => void
  onClose: () => void
  placeholder?: string
  /** Extra controls between the count and the step buttons. */
  actions?: ReactNode
  /** A result list, rendered under the bar (the PDF viewer's page hits). */
  children?: ReactNode
}) {
  return (
    <div className="find-bar">
      <div className="find-row">
        <TextInput
          ref={inputRef}
          className="ui-input find-input"
          placeholder={placeholder}
          value={term}
          spellCheck={false}
          onChange={(e) => onTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onStep(e.shiftKey ? -1 : 1)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <span className="find-count">{count}</span>
        {actions}
        <button className="find-btn" title="Previous (Shift+Enter)" onClick={() => onStep(-1)}>
          ↑
        </button>
        <button className="find-btn" title="Next (Enter)" onClick={() => onStep(1)}>
          ↓
        </button>
        <button className="find-btn" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </div>
  )
}

/**
 * The find bar's keys. Ctrl+F opens — the SHIFTED chord is
 * left alone, because that one is the shell's file-tree filter. Escape closes
 * from wherever the focus sits: the field, the step buttons, or the page.
 */
function useFindKeys({
  active = true,
  open,
  openFind,
  closeFind,
}: {
  active?: boolean
  open: boolean
  openFind: () => void
  closeFind: () => void
}): void {
  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openFind()
      } else if (e.key === 'Escape' && open) {
        closeFind()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, open, openFind, closeFind])
}

/** The box itself: open state, the term, and the keyboard. Both kinds of find
 *  own one — the DOM engine below, and the PDF viewer, whose hits come from
 *  the backend — so opening a find bar behaves the same wherever you are. */
export function useFindBox(active = true) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const openFind = useCallback(() => {
    setOpen(true)
    // Opening while ALREADY open (Ctrl+F twice) does not re-run the effect
    // below, so take the keyboard here too.
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const closeFind = useCallback(() => setOpen(false), [])

  /* Opening hands over the keyboard with the last term selected, so it types
     over — the way every find bar behaves. */
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open])

  useFindKeys({ active, open, openFind, closeFind })

  return { open, term, setTerm, inputRef, openFind, closeFind }
}

/** What a pane needs to render its find bar, ready-made. */
export interface FindState {
  open: boolean
  term: string
  setTerm: (value: string) => void
  step: (delta: number) => void
  openFind: () => void
  closeFind: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** "3/48" / "none" / '' — the bar's count, already worded. */
  count: string
}

/** The count every surface shows, so they cannot word it differently. A
 *  trailing + means the hunt stopped at the cap, not that the page ended. */
export function findCount(needle: string, hits: number, at: number, capped = false): string {
  if (!needle) return ''
  return hits ? `${at + 1}/${hits}${capped ? '+' : ''}` : 'none'
}

/**
 * Find-in-page over a live DOM root — the settings panes, the atlas, anything
 * whose words are already on screen. `getRoot` is a callback rather than a ref
 * because the root can be an iframe's body, which only exists once it loads.
 *
 * Hits are re-found whenever the term changes, the root changes, or the pane
 * itself changes under us: expanding a section or switching a sheet tab
 * rewrites the DOM, and stale Ranges point at nodes nobody can see any more.
 */
export function useFindInPage({
  getRoot,
  active = true,
  /** Bumped by the caller when the content is replaced wholesale. */
  epoch = 0,
}: {
  getRoot: () => HTMLElement | null
  active?: boolean
  epoch?: number
}): FindState {
  const { open, term, setTerm, inputRef, openFind, closeFind } = useFindBox(active)
  const [ranges, setRanges] = useState<Range[]>([])
  const [at, setAt] = useState(0)
  // DOM churn under the root (tab switch, section toggle, a fetch landing).
  const [churn, setChurn] = useState(0)
  const needle = useDebounced(term.trim(), 140)

  /* Finding and painting are one effect: both are side effects on someone
     else's DOM, and doing them apart leaves a window where the highlights
     and the hit list disagree. */
  useEffect(() => {
    const root = getRoot()
    const doc = root?.ownerDocument
    if (!root || !doc) return
    if (!open || !needle) {
      clearHits(doc)
      setRanges([])
      setAt(0)
      return
    }
    const found = findRanges(root, needle)
    setRanges(found)
    // Re-finding after the pane changed keeps your place when it still
    // exists; a shorter list clamps rather than jumping back to the top.
    setAt((current) => (current < found.length ? current : 0))
    return () => clearHits(doc)
  }, [open, needle, getRoot, epoch, churn])

  /* Painting follows the current hit, which the step buttons move. */
  useEffect(() => {
    const doc = getRoot()?.ownerDocument
    if (!doc || !open) return
    paintHits(doc, ranges, at)
  }, [ranges, at, open, getRoot])

  /* Content that changes while the bar is open invalidates the ranges. */
  useEffect(() => {
    const root = getRoot()
    if (!open || !root) return
    let timer = 0
    const view = root.ownerDocument.defaultView
    if (!view) return
    const observer = new view.MutationObserver(() => {
      view.clearTimeout(timer)
      timer = view.setTimeout(() => setChurn((n) => n + 1), 200)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      view.clearTimeout(timer)
      observer.disconnect()
    }
  }, [open, getRoot, epoch])

  const step = useCallback(
    (delta: number) => {
      setAt((current) => {
        if (!ranges.length) return 0
        const next = (current + delta + ranges.length) % ranges.length
        revealRange(ranges[next])
        return next
      })
    },
    [ranges],
  )

  /* A NEW term shows its first hit straight away — nobody types a term to
     then press Enter to see whether it matched. Re-finding the same term
     after the pane changed must not scroll: you are reading hit 12. */
  const revealedFor = useRef('')
  useEffect(() => {
    if (!open || !needle) {
      revealedFor.current = ''
      return
    }
    if (!ranges.length || revealedFor.current === needle) return
    revealedFor.current = needle
    revealRange(ranges[0])
  }, [open, needle, ranges])

  const count = useMemo(
    () => findCount(needle, ranges.length, at, ranges.length >= HIT_CAP),
    [needle, ranges.length, at],
  )

  return { open, term, setTerm, step, openFind, closeFind, inputRef, count }
}
