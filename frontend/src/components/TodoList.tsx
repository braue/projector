import { useEffect, useRef, useState } from 'react'

import { listTodos, saveTodos } from '../api'
import { errorMessage } from '../lib/errors'
import { useDismiss } from '../lib/useDismiss'
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

/** Saves are coalesced: ticking three boxes is one write, not three. */
const SAVE_DEBOUNCE_MS = 400

/** The starting list, shared with the "nothing to save yet" mark below so the
 *  two are the same array and not merely equal. */
const EMPTY: Todo[] = []

export function TodoList() {
  const [open, setOpen] = useState(false)
  const [todos, setTodos] = useState<Todo[]>(EMPTY)
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
  // The list as the server last had it. Every mutator below builds a new
  // array, so an identity check is enough to tell an edit from the list we
  // just fetched — which must not be written straight back.
  const saved = useRef<Todo[]>(EMPTY)
  // Same dismissal as the project switcher, plus Escape: the panel floats
  // over live work, so getting out of it must never need aim.
  const wrap = useDismiss<HTMLDivElement>(open, () => setOpen(false), { escape: true })

  useEffect(() => {
    listTodos().then(
      (stored) => {
        saved.current = stored
        setTodos(stored)
        setLoaded(true)
      },
      (err) => {
        // saved.current stays EMPTY, which is still the list on screen, so a
        // failed read reports itself without writing anything back.
        setError(errorMessage(err))
        setLoaded(true)
      },
    )
  }, [])

  // Persist on change, debounced. Waits for the first fetch so the initial
  // empty state cannot overwrite a stored list, and skips the list we were
  // handed — otherwise every launch would write back what it just read.
  useEffect(() => {
    if (!loaded || todos === saved.current) return
    const timer = setTimeout(() => {
      saveTodos(todos).then(
        () => {
          saved.current = todos
          setError(null)
        },
        (err) => setError(errorMessage(err)),
      )
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [todos, loaded])

  // A closed panel has no open editor to come back to.
  useEffect(() => {
    if (!open) setEditing(null)
  }, [open])

  const done = todos.filter((t) => t.done).length
  const openCount = todos.length - done

  const add = () => {
    const text = draft.trim()
    if (!text) return
    setTodos((list) => [...list, { id: crypto.randomUUID(), text, done: false }])
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
        className={open ? 'topbar-button topbar-toggle on' : 'topbar-button topbar-toggle'}
        onClick={() => setOpen(!open)}
        title={open ? 'Close the todo list' : 'Open the todo list'}
      >
        <span className="topbar-toggle-mark">✓</span>
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
          {loaded && todos.length === 0 && (
            <div className="todo-empty">Nothing on the list.</div>
          )}
          {todos.length > 0 && (
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
