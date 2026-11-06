// The todo board, shared by the topbar toggle (its open count) and the board
// pane. One read, kept current by the backend's `todos` event (and re-read
// after a dropped connection). Every write answers with the whole board,
// which replaces what is shown; a move is applied locally first so a dropped
// card does not hop back while the request is out.

import { useEffect, useSyncExternalStore } from 'react'

import { clearDoneTodos, createTodo, deleteTodo, listTodos, moveTodo, updateTodo } from '../api'
import type { Todo, TodoFields, TodoStatus } from '../types'
import { onEvent } from './events'

/** null until the first read lands. */
let state: Todo[] | null = null
let listening = false
const subscribers = new Set<() => void>()

function set(next: Todo[]) {
  state = next
  for (const fn of subscribers) fn()
}

/** Re-read the board; a failed read keeps what is shown. */
export function reloadTodos(): Promise<void> {
  return listTodos().then(set, () => {})
}

function listen() {
  if (listening) return
  listening = true
  onEvent('todos', reloadTodos)
  onEvent('reconnected', reloadTodos)
}

export function useTodos(): Todo[] | null {
  const current = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    () => state,
  )
  useEffect(() => {
    listen()
    if (state === null) reloadTodos()
  }, [])
  return current
}

/** Writes reject with the server's message; the board is re-read so a failed
 *  optimistic move snaps back. */
async function write(request: Promise<Todo[]>): Promise<void> {
  try {
    set(await request)
  } catch (err) {
    await reloadTodos()
    throw err
  }
}

export const addTodo = (fields: TodoFields) => write(createTodo(fields))
export const editTodo = (id: string, fields: TodoFields) => write(updateTodo(id, fields))
export const removeTodo = (id: string) => write(deleteTodo(id))
export const clearDone = () => write(clearDoneTodos())

export function placeTodo(id: string, status: TodoStatus, before: string | null): Promise<void> {
  if (state) {
    const card = state.find((c) => c.id === id)
    if (card && before !== id) {
      const rest = state.filter((c) => c.id !== id)
      const at = rest.findIndex((c) => c.id === before && c.status === status)
      rest.splice(at < 0 ? rest.length : at, 0, { ...card, status })
      set(rest)
    }
  }
  return write(moveTodo(id, status, before))
}
