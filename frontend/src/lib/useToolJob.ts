// Follow one job the component started until it settles. `start(id)` begins
// following; `job` is its live state (log, progress, waiting) from the event
// stream (lib/jobs.ts). A settled job lands in exactly one callback: onDone
// with its result (fetched once), or onError with the job's message.

import { useEffect, useRef, useState } from 'react'

import { fetchJob } from '../api'
import { errorMessage } from './errors'
import { useJob } from './jobs'

export function useToolJob(
  onDone: (result: unknown) => void,
  onError: (message: string) => void,
) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [settledId, setSettledId] = useState<string | null>(null)
  const job = useJob(jobId ?? settledId)
  // The latest callbacks, without making them effect dependencies.
  const callbacks = useRef({ onDone, onError })
  callbacks.current = { onDone, onError }

  // A job we have seen that drops out of the registry while still followed
  // was lost with a backend restart (finished jobs settle before they can
  // be dismissed).
  const seen = useRef(false)
  useEffect(() => {
    if (!jobId) return
    if (!job) {
      if (seen.current) {
        setJobId(null)
        callbacks.current.onError('The backend restarted and this job was lost — run it again.')
      }
      return
    }
    seen.current = true
    if (job.status === 'running') return
    const id = jobId
    setJobId(null)
    setSettledId(id)
    if (job.status === 'error') {
      callbacks.current.onError(job.error ?? 'job failed')
      return
    }
    fetchJob(id).then(
      (full) => callbacks.current.onDone(full.result),
      (err) => callbacks.current.onError(errorMessage(err)),
    )
  }, [jobId, job])

  const start = (id: string) => {
    seen.current = false
    setSettledId(null)
    setJobId(id)
  }

  return { job, running: jobId !== null, start }
}
