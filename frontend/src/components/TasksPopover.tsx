import { useEffect, useState } from 'react'

import { abortJob, clearFinishedJobs, dismissJob, retryJob } from '../api'
import { useJobs } from '../lib/jobs'
import { useDismiss } from '../lib/useDismiss'
import type { ToolJob } from '../types'
import { Spinner } from './ui'

// Everything the backend is working on, in one place: a small button in the
// bottom-right corner that appears once there is any background work, and
// opens a list of it — tool runs, AcRTAC downloads/imports/opens, uploads.
// It is the ONLY place work in progress shows: the file tree draws files,
// never spinners or pending rows; a failed download is retried from here.
// Each row shows what it is waiting on or its latest log line; clicking a row
// shows its log. A running row can be aborted (■) — timeouts are long, so a
// job that goes wrong early is stopped here rather than waited out. Finished rows stay until dismissed (or aged out by the
// backend), so a failure that happened while you were elsewhere is still
// there to read.

function elapsed(job: ToolJob, now: number): string {
  const from = Date.parse(job.startedAt)
  const to = job.endedAt ? Date.parse(job.endedAt) : now
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function StatusMark({ job }: { job: ToolJob }) {
  if (job.status === 'done') return <span className="tasks-mark ok">✓</span>
  if (job.status === 'error') return <span className="tasks-mark bad">✕</span>
  if (job.waiting) return <span className="tasks-mark wait" title={job.waiting}>⏸</span>
  return <Spinner />
}

export function TasksPopover() {
  const jobs = useJobs()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Failures the user hasn't opened the list to see yet turn the button red.
  const [seenFailures, setSeenFailures] = useState<Set<string>>(new Set())
  const wrap = useDismiss<HTMLDivElement>(open, () => setOpen(false), { escape: true })

  const running = jobs.filter((job) => job.status === 'running')
  const failed = jobs.filter((job) => job.status === 'error')
  const unseenFailures = failed.filter((job) => !seenFailures.has(job.id))

  // Tick the elapsed times while something runs and the list is up.
  useEffect(() => {
    if (!open || !running.length) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, running.length])

  useEffect(() => {
    if (open) setSeenFailures(new Set(failed.map((job) => job.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, failed.length])

  if (!jobs.length) return null

  const newestFirst = [...jobs].reverse()
  // The words always say what happened; red only means "not looked at yet".
  const summary = running.length
    ? `${running.length} running`
    : failed.length
      ? `${failed.length} failed${jobs.length > failed.length ? ` · ${jobs.length - failed.length} done` : ''}`
      : `${jobs.length} done`

  return (
    <div className="tasks" ref={wrap}>
      {open && (
        <div className="tasks-popover" role="dialog" aria-label="Tasks">
          <div className="tasks-head">
            <span className="t">Tasks</span>
            {jobs.length > running.length && (
              <button className="tasks-link" onClick={() => clearFinishedJobs().catch(() => {})}>
                Clear finished
              </button>
            )}
          </div>
          <ul className="tasks-list">
            {newestFirst.map((job) => {
              const isOpen = expanded === job.id
              const detail = job.status === 'error' ? job.error
                : job.waiting ?? job.log.at(-1) ?? (job.status === 'running' ? 'Starting…' : 'Finished')
              return (
                <li key={job.id} className={`tasks-item tasks-${job.status}`}>
                  <button className="tasks-row" onClick={() => setExpanded(isOpen ? null : job.id)}
                    title={isOpen ? 'Hide the log' : 'Show the log'}>
                    <StatusMark job={job} />
                    <span className="tasks-text">
                      <span className="tasks-label">{job.label}</span>
                      <span className="tasks-detail">{detail}</span>
                    </span>
                    <span className="tasks-time">{elapsed(job, now)}</span>
                  </button>
                  {job.status === 'running' && (
                    <span className="tasks-actions">
                      <button className="abort" title="Abort" onClick={() => abortJob(job.id).catch(() => {})}>■</button>
                    </span>
                  )}
                  {job.status !== 'running' && (
                    <span className="tasks-actions">
                      {job.retryable && (
                        <button title="Try again" onClick={() => retryJob(job.id).catch(() => {})}>↻</button>
                      )}
                      <button title="Dismiss" onClick={() => dismissJob(job.id).catch(() => {})}>✕</button>
                    </span>
                  )}
                  {isOpen && (
                    <div className="tasks-log">
                      {job.log.length
                        ? job.log.slice(-60).map((line, i) => <div key={i}>{line}</div>)
                        : <div className="tasks-empty">Nothing logged yet.</div>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <button
        className={`tasks-button${unseenFailures.length && !running.length ? ' bad' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title={open ? 'Hide tasks' : 'Show tasks'}
      >
        {running.length ? <Spinner /> : failed.length ? <span>✕</span> : <span>✓</span>}
        <span>{summary}</span>
      </button>
    </div>
  )
}
