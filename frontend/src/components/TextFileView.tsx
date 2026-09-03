import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { readTextFile, saveTextFile } from '../api'
import { errorMessage } from '../lib/errors'

// The built-in text editor — how notes live now: plain .txt files in the
// project tree, edited in place. ONE plain textarea, like any text editor:
// free typing, multi-line selection, ordinary copy/paste. List markers are
// plain-text conventions the editor assists with, never structure it
// imposes:
//
//   "[ ] task"   a checkbox — CLICK it to tick (or type an x)
//   "- point"    a bullet ("*" works too)
//   "1. step"    a numbered item
//
// Enter continues the current line's marker (numbers increment); Enter on a
// marker-only line ends the list; Tab / Shift+Tab indent and outdent the
// line. Saves are debounced and flushed on blur and unmount. Saving in
// place is NOT a new version — versions mark deliberate arrivals.
//
// Clickable checkboxes without giving up the textarea: an OVERLAY mirrors
// the text with identical metrics, transparent and non-interactive — except
// the "[ ]"/"[x]" tokens at line starts, which are invisible click targets
// floating exactly over their characters.

const SAVE_DEBOUNCE_MS = 600

// indent + marker of a list line: "[ ] " / "[x] " / "- " / "* " / "3. " / "3) "
const LIST_MARKER = /^([ \t]*)(\[[ xX]\] |[-*] |\d+[.)] )/

/** "2/5" over the checkbox lines; null when the text has none. */
export function checkCounts(text: string): string | null {
  const lines = text.split('\n')
  const checks = lines.filter((line) => /^[ \t]*\[[ xX]\]/.test(line))
  if (!checks.length) return null
  const done = checks.filter((line) => /^[ \t]*\[[xX]\]/.test(line)).length
  return `${done}/${checks.length}`
}

export function TextFileView({
  project,
  path,
  name,
  /** Archived versions are historical record, not a working document. */
  readOnly = false,
}: {
  project: string
  path: string
  name: string
  readOnly?: boolean
}) {
  const [text, setTextState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  // Where the caret belongs after a programmatic edit (Enter/Tab rewrite the
  // controlled value; React resets selection without this).
  const caret = useRef<number | null>(null)
  // Debounced autosave: at most one pending save; chained so saves can't
  // overlap or arrive out of order.
  const saveTimer = useRef<number | undefined>(undefined)
  const pendingSave = useRef<string | null>(null)
  const saveChain = useRef(Promise.resolve())

  useEffect(() => {
    let live = true
    setTextState(null)
    setError(null)
    readTextFile(project, path).then(
      (value) => {
        if (live) setTextState(value)
      },
      (err) => {
        if (live) setError(errorMessage(err))
      },
    )
    return () => {
      live = false
    }
  }, [project, path])

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    const save = pendingSave.current
    if (save === null) return
    pendingSave.current = null
    saveChain.current = saveChain.current
      .then(() => saveTextFile(project, path, save))
      .then(() => undefined, (err) => setError(errorMessage(err)))
  }, [project, path])

  // Unsaved text must not outlive the view (selection/project switch).
  useEffect(() => flush, [flush])

  const setText = (value: string) => {
    setTextState(value)
    pendingSave.current = value
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  // Restore the caret after Enter/Tab rewrote the value.
  useEffect(() => {
    if (caret.current === null) return
    editor.current?.setSelectionRange(caret.current, caret.current)
    caret.current = null
  })

  // A programmatic edit: replace [from, to) with `insert`, caret after it.
  const edit = (value: string, from: number, to: number, insert: string) => {
    caret.current = from + insert.length
    setText(value.slice(0, from) + insert + value.slice(to))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const { value, selectionStart, selectionEnd } = el
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1

    if (e.key === 'Enter') {
      const line = value.slice(lineStart, selectionStart)
      const marker = line.match(LIST_MARKER)
      if (!marker) return // plain newline — let the browser handle it
      e.preventDefault()
      if (line === marker[0].trimEnd() || line === marker[0]) {
        // Marker-only line: end the list (clear the marker).
        edit(value, lineStart, selectionEnd, '')
        return
      }
      const numbered = marker[2].match(/^(\d+)([.)] )$/)
      const next = numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : marker[2].replace(/\[[xX]\]/, '[ ]')
      edit(value, selectionStart, selectionEnd, `\n${marker[1]}${next}`)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        // Outdent: drop one leading tab (or up to two spaces) from the line.
        const outdented = value.slice(lineStart).match(/^(\t| {1,2})/)
        if (outdented) {
          caret.current = Math.max(lineStart, selectionStart - outdented[1].length)
          setText(value.slice(0, lineStart) + value.slice(lineStart + outdented[1].length))
        }
      } else {
        // Indent the whole line — sub-items tab in.
        caret.current = selectionStart + 1
        setText(`${value.slice(0, lineStart)}\t${value.slice(lineStart)}`)
      }
    }
  }

  // The overlay's mirror of the text: line-start "[ ]"/"[x]" tokens become
  // click targets carrying their absolute offset; everything else is inert
  // transparent text that only exists to keep the tokens in place.
  const overlayNodes = useMemo<ReactNode[]>(() => {
    if (text === null) return []
    const nodes: ReactNode[] = []
    let offset = 0
    text.split('\n').forEach((line, index) => {
      if (index > 0) {
        nodes.push('\n')
        offset += 1
      }
      const marker = line.match(/^([ \t]*)(\[[ xX]\])/)
      if (marker) {
        const boxOffset = offset + marker[1].length
        nodes.push(marker[1])
        nodes.push(
          <span
            key={boxOffset}
            className="note-checkbox"
            data-offset={boxOffset}
            title="Toggle"
          >
            {marker[2]}
          </span>,
        )
        nodes.push(line.slice(marker[0].length))
      } else {
        nodes.push(line)
      }
      offset += line.length
    })
    return nodes
  }, [text])

  const onOverlayMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (readOnly || text === null || !target.classList.contains('note-checkbox')) return
    // Toggle without stealing focus or moving the caret.
    e.preventDefault()
    const at = Number(target.dataset.offset) + 1
    const ticked = text[at] !== ' '
    setText(`${text.slice(0, at)}${ticked ? ' ' : 'x'}${text.slice(at + 1)}`)
  }

  return (
    <main className="preview">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{name}</h2>
          {text !== null && <span className="note-count">{checkCounts(text)}</span>}
          {readOnly && <span className="note-count">read-only version</span>}
        </div>
        <div className="preview-subtitle">
          <span className="mono">{path}</span>
        </div>
      </header>
      {text === null ? (
        <div className="pane-message">{error ?? 'Loading…'}</div>
      ) : (
        <div className="note-editor-wrap">
          <textarea
            ref={editor}
            className="note-editor"
            value={text}
            readOnly={readOnly}
            placeholder={'Write freely. Start a line with "[ ] " for a checkbox (click or type an x to tick it), "- " for a bullet, "1. " for a numbered list.'}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onBlur={flush}
            onKeyDown={readOnly ? undefined : onKeyDown}
            onScroll={(e) => {
              if (overlay.current) overlay.current.scrollTop = e.currentTarget.scrollTop
            }}
          />
          <div
            ref={overlay}
            className="note-overlay"
            aria-hidden
            onMouseDown={onOverlayMouseDown}
          >
            {overlayNodes}
            {'\n'}
          </div>
          {error && <div className="list-error"><div className="list-error-text">{error}</div></div>}
        </div>
      )}
    </main>
  )
}
