// Projector's project list, shared by everything in the window that names a
// project — the switcher, every tool's project dropdown, the hours panel.
// One read, kept current by the backend's `projects` event (and re-read after
// a dropped connection), so a project created, renamed, archived or deleted
// anywhere shows up everywhere without each picker fetching its own copy.

import { useEffect, useSyncExternalStore } from 'react'

import { listProjects } from '../api'
import { onEvent } from './events'

export interface ProjectList {
  /** Every project, sorted; archived ones included. */
  projects: string[]
  /** The subset filed under Archive. */
  archived: string[]
}

/** null until the first read lands. */
let state: ProjectList | null = null
let inflight: Promise<ProjectList | null> | null = null
let listening = false
const subscribers = new Set<() => void>()

/** Re-read the list. Resolves to it, or null when the backend is unreachable
 *  (the last good list stays in place). Concurrent calls share one read. */
export function reloadProjects(): Promise<ProjectList | null> {
  inflight ??= listProjects()
    .then(
      (list) => {
        state = list
        for (const fn of subscribers) fn()
        return list
      },
      () => null,
    )
    .finally(() => {
      inflight = null
    })
  return inflight
}

function listen() {
  if (listening) return
  listening = true
  onEvent('projects', reloadProjects)
  onEvent('reconnected', reloadProjects)
}

export function useProjectList(): ProjectList | null {
  const current = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    () => state,
  )
  useEffect(() => {
    listen()
    if (state === null) reloadProjects()
  }, [])
  return current
}

/** Dropdown options for a project picker: active projects, then archived
 *  ones, marked. `keep` (the picker's current value) always appears, so a
 *  project deleted out from under a form still reads as what it was. */
export function projectOptions(
  list: ProjectList | null,
  keep?: string | null,
): { value: string; label: string }[] {
  const projects = list?.projects ?? []
  const archived = list?.archived ?? []
  const active = projects.filter((name) => !archived.includes(name))
  const shelved = projects.filter((name) => archived.includes(name))
  const options = [
    ...active.map((name) => ({ value: name, label: name })),
    ...shelved.map((name) => ({ value: name, label: `${name} · archived` })),
  ]
  if (keep && !projects.includes(keep)) options.unshift({ value: keep, label: keep })
  return options
}
