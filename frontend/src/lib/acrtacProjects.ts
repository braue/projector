// The AcRTAC database's project list, shared by every picker in the window
// (tree download, RTAC Exporter, RTAC VLAN Deploy). The backend caches it
// (services/rtacCatalog.js); this caches the answer here too, so opening a
// second picker is instant and Refresh anywhere refreshes everywhere.

import { useEffect, useSyncExternalStore } from 'react'

import { fetchAcrtacProjects, refreshAcrtacProjects } from '../api'
import { errorMessage } from './errors'

interface State {
  /** null while the first read is in flight. */
  projects: string[] | null
  error: string | null
  loading: boolean
}

let state: State = { projects: null, error: null, loading: false }
const subscribers = new Set<() => void>()

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const fn of subscribers) fn()
}

async function load(refresh: boolean) {
  if (state.loading) return
  set({ loading: true, ...(refresh ? { projects: null } : {}) })
  try {
    const list = refresh ? await refreshAcrtacProjects() : await fetchAcrtacProjects()
    set({ projects: list.projects, error: list.error, loading: false })
  } catch (err) {
    set({ projects: state.projects ?? [], error: errorMessage(err), loading: false })
  }
}

/** The list (read on first use), and a Refresh that re-reads the database. */
export function useAcrtacProjects() {
  const current = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    () => state,
  )
  useEffect(() => {
    if (state.projects === null && !state.loading) load(false)
  }, [])
  return { ...current, refresh: () => load(true) }
}
