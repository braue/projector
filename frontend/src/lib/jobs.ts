// Every background job the backend is running or has finished (backend
// services/jobs.js), kept current from the event stream: a `jobs` snapshot
// on (re)connect, then `job` / `job-removed` as things happen. The tasks
// popover draws all of them; tools and the tree read the ones they started.

import { useSyncExternalStore } from 'react'

import type { ToolJob } from '../types'
import { onEvent } from './events'

let jobs = new Map<string, ToolJob>()
let list: ToolJob[] = []
const subscribers = new Set<() => void>()
let started = false

function changed() {
  list = [...jobs.values()]
  for (const fn of subscribers) fn()
}

function start() {
  if (started) return
  started = true
  onEvent('jobs', ({ jobs: all }: { jobs: ToolJob[] }) => {
    jobs = new Map(all.map((job) => [job.id, job]))
    changed()
  })
  onEvent('job', (job: ToolJob) => {
    jobs = new Map(jobs).set(job.id, job)
    changed()
  })
  onEvent('job-removed', ({ id }: { id: string }) => {
    if (!jobs.has(id)) return
    jobs = new Map(jobs)
    jobs.delete(id)
    changed()
  })
}

function subscribe(fn: () => void) {
  start()
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Every job, oldest first. */
export function useJobs(): ToolJob[] {
  return useSyncExternalStore(subscribe, () => list)
}

/** One job's live state (without its result), or null. */
export function useJob(id: string | null): ToolJob | null {
  return useSyncExternalStore(subscribe, () => (id ? jobs.get(id) ?? null : null))
}
