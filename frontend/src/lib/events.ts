// The backend's event stream (GET /api/events, backend lib/events.js) — one
// EventSource for the whole window, opened on first use. It is how the
// window learns that a job moved, a project's files changed on disk, or the
// project list changed, instead of asking over and over.
//
// A dropped stream (the backend restarting) reconnects by itself; listeners
// of `reconnected` re-read what they show, since events in the gap are lost.

import { useSyncExternalStore } from 'react'

type Listener = (data: any) => void // eslint-disable-line @typescript-eslint/no-explicit-any

const listeners = new Map<string, Set<Listener>>()
let source: EventSource | null = null
let connected = true
let everDropped = false
const connectionListeners = new Set<() => void>()

function setConnected(next: boolean) {
  if (connected === next) return
  connected = next
  for (const fn of connectionListeners) fn()
}

function emit(type: string, data: unknown) {
  for (const fn of listeners.get(type) ?? []) fn(data)
}

function ensureOpen() {
  if (source) return
  source = new EventSource('/api/events')
  source.onopen = () => {
    setConnected(true)
    if (everDropped) emit('reconnected', {})
  }
  source.onerror = () => {
    everDropped = true
    setConnected(false)
  }
  // Every event type the backend sends is routed by name; the set of names
  // is open-ended, so hook each the first time someone listens for it.
}

function hook(type: string) {
  if (type === 'reconnected') return
  source!.addEventListener(type, (e) => emit(type, JSON.parse((e as MessageEvent).data)))
}

/** Listen for one event type; returns the unsubscribe. */
export function onEvent(type: string, fn: Listener): () => void {
  ensureOpen()
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
    hook(type)
  }
  set.add(fn)
  return () => set.delete(fn)
}

/** Whether the backend's stream is up — false while it restarts. */
export function useConnected(): boolean {
  return useSyncExternalStore(
    (fn) => {
      ensureOpen()
      connectionListeners.add(fn)
      return () => connectionListeners.delete(fn)
    },
    () => connected,
  )
}
