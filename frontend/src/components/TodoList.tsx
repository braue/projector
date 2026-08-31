import { useEffect, useMemo, useRef, useState } from 'react'

import { listTodos, saveTodos } from '../api'
import { errorMessage } from '../lib/errors'
import type { Todo } from '../types'

import { Checkbox, InlineNameForm, RowAction, TextInput } from './ui'

// A general scratch list: the one thing in the app that is deliberately NOT
// project data. It rides in the topbar beside Tools and the Atlas rather than
// in the mode row, and it drops as a floating panel instead of taking the
// pane over — a task gets jotted mid-thought, without leaving the canvas.
//
// It is stored server-side, in <dataDir>/todos.json, NOT in localStorage.
// The packaged app listens on port 0, so the window origin
// (http://127.0.0.1:<port>) differs on every launch and anything Chromium
// keys by origin is gone by the next start. The data directory is also what
// an upgrade preserves — it lives outside the install folder the installer
// replaces — so the list survives both.

/** Where the list used to live. Read once, then cleared — see migrate(). */
const LEGACY_KEY = 'projector-todos'

/** Saves are coalesced: ticking three boxes is one write, not three. */
const SAVE_DEBOUNCE_MS = 400

/**
 * Carry a list written by the build that kept todos in localStorage into the
 * data directory. Only ever runs against an empty server list, so it cannot
 * resurrect items deleted since, and the key is dropped either way so this
 * happens exactly once per origin.
 */
function migrate(stored: Todo[]): Todo[] {
  let legacy: Todo[] = []
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]')
    if (Array.isArray(raw)) {
      legacy = raw
        .filter((t): t is Todo => !!t && typeof t.id === 'string' && typeof t.text === 'string')
        .map((t) => ({ id: t.id, text: t.text, done: !!t.done }))
    }
  } catch {
    legacy = []
  }
  localStorage.removeItem(LEGACY_KEY)
  return stored.length === 0 ? legacy : stored
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function TodoList() {
  const [open, setOpen] = useState(false)
  const [todos, setTodos] = useState<Todo[]>([])
  // Distinguishes "no todos" from "not fetched yet", so the empty state does
  // not flash before the list arrives.
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  // The row being dragged, and whether a drag is allowed to start at all:
  // only the grip arms it, so a click on the text can still open the editor.
  const [dragId, setDragId] = useState<string | null>(null)
  const [gripped, setGripped] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listTodos().then(
      (stored) => {
        const merged = migrate(stored)
        setTodos(merged)
        setLoaded(true)
        // A migration is only real once it lands on disk.
        if (merged !== stored) saveTodos(merged).catch((err) => setError(errorMessage(err)))
      },
      (err) => {
        setError(errorMessage(err))
        setLoaded(true)
      },
    )
  }, [])

  // Persist on change, debounced. Skipped until the first fetch lands so the
  // initial empty state can never overwrite a stored list.
  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => {
      saveTodos(todos).then(
        () => setError(null),
        (err) => setError(errorMessage(err)),
      )
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [todos, loaded])

  // Same dismissal as the project switcher, plus Escape — the panel floats
  // over live work, so getting out of it must never need aim.
  useEffect(() => {
    if (!open) {
      setEditing(null)
      return
    }
    const clickAway = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    // An open item editor stops the key before it reaches here, so Escape
    // cancels that edit first and closes the panel only on a second press.
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', clickAway)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', clickAway)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const done = useMemo(() => todos.filter((t) => t.done).length, [todos])
  const openCount = todos.length - done

  const add = () => {
    const text = draft.trim()
    if (!text) return
    setTodos((list) => [...list, { id: newId(), text, done: false }])
    setDraft('')
  }

  const update = (id: string, patch: Partial<Todo>) =>
    setTodos((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  const remove = (id: string) => setTodos((list) => list.filter((t) => t.id !== id))

  /** Drop `from` onto `to`'s slot — called as the pointer crosses each row,
   *  so the list settles into its new order under the cursor. */
  const move = (from: string, to: string) =>
    setTodos((list) => {
      const a = list.findIndex((t) => t.id === from)
      const b = list.findIndex((t) => t.id === to)
      if (a < 0 || b < 0 || a === b) return list
      const next = [...list]
      const [moved] = next.splice(a, 1)
      next.splice(b, 0, moved)
      return next
    })

  return (
    <div className="todo-switch" ref={wrap}>
      <button
        className={open ? 'topbar-button atlas-toggle on' : 'topbar-button atlas-toggle'}
        onClick={() => setOpen(!open)}
        title={open ? 'Close the todo list' : 'Open the todo list'}
      >
        <span className="atlas-toggle-mark">✓</span>
        <span>Todo</span>
        {openCount > 0 && <span className="todo-count">{openCount}</span>}
      </button>
      {open && (
        <div className="todo-menu">
          <div className="todo-head">
            <span className="t">Todo</span>
            {todos.length > 0 && (
              <span className="n">
                {done}/{todos.length}
              </span>
            )}
          </div>
          {todos.length > 0 && (
            <div className="todo-bar">
              <i style={{ width: `${(done / todos.length) * 100}%` }} />
            </div>
          )}
          <div className="todo-add">
            <TextInput
              value={draft}
              placeholder="Add a task — Enter to save"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
            />
          </div>
          {error && <div className="todo-error">{error}</div>}
          {todos.length === 0 ? (
            loaded && <div className="todo-empty">Nothing on the list.</div>
          ) : (
            <div className="todo-list">
              {todos.map((todo) => (
                <div
                  key={todo.id}
                  className={[
                    'todo-row',
                    todo.done ? 'done' : '',
                    dragId === todo.id ? 'dragging' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={gripped}
                  onDragStart={() => setDragId(todo.id)}
                  onDragEnd={() => {
                    setDragId(null)
                    setGripped(false)
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return
                    e.preventDefault()
                    if (dragId !== todo.id) move(dragId, todo.id)
                  }}
                >
                  <span
                    className="todo-grip"
                    title="Drag to reorder"
                    onMouseDown={() => setGripped(true)}
                    onMouseUp={() => setGripped(false)}
                  >
                    ⠿
                  </span>
                  <Checkbox
                    checked={todo.done}
                    onChange={(checked) => update(todo.id, { done: checked })}
                  />
                  {editing === todo.id ? (
                    <InlineNameForm
                      initial={todo.text}
                      placeholder="Task — Enter to save"
                      onCommit={(text) => {
                        update(todo.id, { text })
                        setEditing(null)
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <span
                      className="todo-text"
                      title="Click to edit"
                      onClick={() => setEditing(todo.id)}
                    >
                      {todo.text}
                    </span>
                  )}
                  <RowAction
                    kind="delete"
                    title={`Delete “${todo.text}”`}
                    onClick={() => remove(todo.id)}
                  />
                </div>
              ))}
            </div>
          )}
          {todos.length > 0 && (
            <div className="todo-foot">
              <span>{openCount === 0 ? 'All done.' : `${openCount} left`}</span>
              {done > 0 && (
                <button className="todo-clear" onClick={() => setTodos((l) => l.filter((t) => !t.done))}>
                  Clear {done} done
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
