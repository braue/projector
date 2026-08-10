import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { createNote, deleteNote, listNotes, renameNote, saveNoteText } from '../api'
import { errorMessage } from '../lib/errors'
import { useSidebarWidth } from '../lib/usePaneWidth'
import type { Note } from '../types'
import { InlineNameForm, RowAction } from './ui'

// Notes mode — the engineer's own working notes beside the evidence. Left
// rail lists the project's notes (create / rename / delete); the pane is ONE
// plain textarea, like any text editor: free typing, multi-line selection,
// ordinary copy/paste. List markers are plain-text conventions the editor
// assists with, never structure it imposes:
//
//   "[ ] task"   a checkbox — CLICK it to tick (or type an x)
//   "- point"    a bullet ("*" works too)
//   "1. step"    a numbered item
//
// Enter continues the current line's marker (numbers increment); Enter on a
// marker-only line ends the list; Tab / Shift+Tab indent and outdent the
// line. Saves are debounced and flushed on blur and note switch.
//
// Clickable checkboxes without giving up the textarea: an OVERLAY mirrors
// the text with identical metrics (font, padding, wrap, tab size), rendered
// transparent and non-interactive — except the "[ ]"/"[x]" tokens at line
// starts, which are invisible click targets floating exactly over their
// characters. Clicking one flips the char in the text; the textarea never
// loses its behavior. The overlay scroll-syncs to the textarea.

const SAVE_DEBOUNCE_MS = 600

// indent + marker of a list line: "[ ] " / "[x] " / "- " / "* " / "3. " / "3) "
const LIST_MARKER = /^([ \t]*)(\[[ xX]\] |[-*] |\d+[.)] )/

// "2/5" over the checkbox lines; null when a note has none.
function checkCounts(note: Note): string | null {
  const lines = note.text.split('\n')
  const checks = lines.filter((line) => /^[ \t]*\[[ xX]\]/.test(line))
  if (!checks.length) return null
  const done = checks.filter((line) => /^[ \t]*\[[xX]\]/.test(line)).length
  return `${done}/${checks.length}`
}

export function NotesView({
  project,
  initialSelectedId = null,
}: {
  project: string
  /** Select this note once the list loads (a jump from Notes › Search). */
  initialSelectedId?: string | null
}) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  // Starts on the jump target (the view remounts per sub-mode toggle, so a
  // mount-time initializer is enough); load() drops it if it no longer exists.
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [error, setError] = useState<string | null>(null)
  // The InlineNameForm owns its value and error; these just mark which row
  // (or the create slot) is editing.
  const [naming, setNaming] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const { width, startResize } = useSidebarWidth()
  const editor = useRef<HTMLTextAreaElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  // Where the caret belongs after a programmatic edit (Enter/Tab rewrite the
  // controlled value; React resets selection without this).
  const caret = useRef<number | null>(null)
  // Debounced autosave: at most one pending save; chained so saves can't
  // overlap or arrive out of order.
  const saveTimer = useRef<number | undefined>(undefined)
  const pendingSave = useRef<{ id: string; text: string } | null>(null)
  const saveChain = useRef(Promise.resolve())

  const load = useCallback(async () => {
    try {
      const fetched = await listNotes(project)
      setNotes(fetched)
      setSelectedId((current) => (fetched.some((note) => note.id === current) ? current : fetched[0]?.id ?? null))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [project])

  useEffect(() => {
    setNotes(null)
    load()
  }, [load])

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    const save = pendingSave.current
    if (!save) return
    pendingSave.current = null
    saveChain.current = saveChain.current
      .then(() => saveNoteText(project, save.id, save.text))
      .then(() => undefined, (err) => {
        setError(errorMessage(err))
        load()
      })
  }, [project, load])

  // Unsaved text must not outlive the view (mode/project switch).
  useEffect(() => flush, [flush])

  const selected = notes?.find((note) => note.id === selectedId) ?? null

  const setText = (noteId: string, text: string) => {
    setNotes((current) => current?.map((note) => (note.id === noteId ? { ...note, text } : note)) ?? current)
    pendingSave.current = { id: noteId, text }
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  const selectNote = (id: string) => {
    flush()
    setSelectedId(id)
  }

  // Restore the caret after Enter/Tab rewrote the value.
  useEffect(() => {
    if (caret.current === null) return
    editor.current?.setSelectionRange(caret.current, caret.current)
    caret.current = null
  })

  // A programmatic edit: replace [from, to) with `insert`, caret after it.
  const edit = (noteId: string, value: string, from: number, to: number, insert: string) => {
    caret.current = from + insert.length
    setText(noteId, value.slice(0, from) + insert + value.slice(to))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!selected) return
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
        edit(selected.id, value, lineStart, selectionEnd, '')
        return
      }
      const numbered = marker[2].match(/^(\d+)([.)] )$/)
      const next = numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : marker[2].replace(/\[[xX]\]/, '[ ]')
      edit(selected.id, value, selectionStart, selectionEnd, `\n${marker[1]}${next}`)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        // Outdent: drop one leading tab (or up to two spaces) from the line.
        const outdented = value.slice(lineStart).match(/^(\t| {1,2})/)
        if (outdented) {
          caret.current = Math.max(lineStart, selectionStart - outdented[1].length)
          setText(selected.id, value.slice(0, lineStart) + value.slice(lineStart + outdented[1].length))
        }
      } else {
        // Indent the whole line — sub-items tab in.
        caret.current = selectionStart + 1
        setText(selected.id, `${value.slice(0, lineStart)}\t${value.slice(lineStart)}`)
      }
    }
  }

  // The overlay's mirror of the text: line-start "[ ]"/"[x]" tokens become
  // click targets carrying their absolute offset; everything else is inert
  // transparent text that only exists to keep the tokens in place.
  const overlayNodes = useMemo<ReactNode[]>(() => {
    if (!selected) return []
    const nodes: ReactNode[] = []
    let offset = 0
    selected.text.split('\n').forEach((line, index) => {
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
  }, [selected])

  const onOverlayMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!selected || !target.classList.contains('note-checkbox')) return
    // Toggle without stealing focus or moving the caret.
    e.preventDefault()
    const at = Number(target.dataset.offset) + 1
    const text = selected.text
    const ticked = text[at] !== ' '
    setText(selected.id, `${text.slice(0, at)}${ticked ? ' ' : 'x'}${text.slice(at + 1)}`)
  }

  const create = async (name: string) => {
    const created = await createNote(project, name)
    setNaming(false)
    await load()
    setSelectedId(created.id)
  }

  const remove = async (note: Note) => {
    if (!window.confirm(`Delete note "${note.name}"?`)) return
    try {
      await deleteNote(project, note.id)
      setError(null)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <>
      <aside className="sources" style={{ width }}>
        <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
        <div className="source-scroll">
          {naming ? (
            <InlineNameForm
              placeholder="Note name — Enter to create"
              onCommit={create}
              onCancel={() => setNaming(false)}
            />
          ) : (
            <button className="drop-zone as-button" onClick={() => setNaming(true)}>
              <b>New note</b>
              name it, press Enter
            </button>
          )}
          <ul className="source-list">
            {(notes ?? []).map((note) =>
              renamingId === note.id ? (
                <li key={note.id}>
                  <InlineNameForm
                    initial={note.name}
                    placeholder="New name — Enter to rename"
                    onCommit={async (value) => {
                      await renameNote(project, note.id, value)
                      setRenamingId(null)
                      await load()
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                </li>
              ) : (
                <li key={note.id}>
                  <button
                    className={note.id === selectedId ? 'project-entry status-ready selected' : 'project-entry status-ready'}
                    onClick={() => selectNote(note.id)}
                  >
                    <span className="project-name">{note.name}</span>
                    <span className="note-count">{checkCounts(note)}</span>
                    <RowAction kind="rename" title={`Rename ${note.name}`} onClick={() => setRenamingId(note.id)} />
                    <RowAction kind="delete" title={`Delete ${note.name}`} onClick={() => remove(note)} />
                  </button>
                </li>
              ),
            )}
          </ul>
          {error && (
            <div className="list-error">
              <div className="list-error-text">{error}</div>
            </div>
          )}
        </div>
      </aside>

      <main className="preview">
        {selected ? (
          <>
            <header className="preview-header">
              <div className="preview-title-row">
                <h2>{selected.name}</h2>
                <span className="note-count">{checkCounts(selected)}</span>
              </div>
            </header>
            <div className="note-editor-wrap">
              <textarea
                ref={editor}
                className="note-editor"
                value={selected.text}
                placeholder={'Write freely. Start a line with "[ ] " for a checkbox (click or type an x to tick it), "- " for a bullet, "1. " for a numbered list.'}
                spellCheck={false}
                onChange={(e) => setText(selected.id, e.target.value)}
                onBlur={flush}
                onKeyDown={onKeyDown}
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
            </div>
          </>
        ) : (
          <div className="note-empty">
            {notes === null ? 'Loading…' : 'Create a note to start writing.'}
          </div>
        )}
      </main>
    </>
  )
}
