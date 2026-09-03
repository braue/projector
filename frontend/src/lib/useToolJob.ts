// Poll one tool job until it settles — the frontend half of the backend's
// jobs registry (every job-shaped tool shares the same poll-until-settled
// shape). `start(id)` begins polling; `job` tracks the latest state for log
// rendering while it runs. A settled job lands in exactly one callback:
// onDone with its result, or onError with the job's (or the poll's) message.

import { useEffect, useState } from 'react'

import { fetchToolJob } from '../api'
import type { ToolJob } from '../types'
import { errorMessage } from './errors'

const POLL_MS = 1200

export function useToolJob(
  onDone: (result: unknown) => void,
  onError: (message: string) => void,
) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<ToolJob | null>(null)

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const tick = async () => {
      try {
        const state = await fetchToolJob(jobId)
        if (cancelled) return
        setJob(state)
        if (state.status === 'running') {
          window.setTimeout(tick, POLL_MS)
          return
        }
        setJobId(null)
        if (state.status === 'done') onDone(state.result)
        else onError(state.error ?? 'job failed')
      } catch (err) {
        if (!cancelled) {
          setJobId(null)
          onError(errorMessage(err))
        }
      }
    }
    tick()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const start = (id: string) => {
    setJob(null)
    setJobId(id)
  }

  return { job, running: jobId !== null, start }
}
