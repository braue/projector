import { useEffect, useMemo, useRef, useState } from 'react'

import { fetchHours, setBudgetHours, setDayHours } from '../api'
import { errorMessage } from '../lib/errors'
import { onEvent } from '../lib/events'
import { useProjectList } from '../lib/projectList'
import { useDismiss } from '../lib/useDismiss'
import type { Hours } from '../types'

import { RowAction, Select } from './ui'

// Billable hours: a week grid — projects down, Mon–Sun across — with each
// project's running total against its budget. Machine-global like the todo
// list (a week bills to many projects, not the open one), and it drops from
// the topbar the same way, so hours get logged without leaving the work.
//
// Rows are the projects with hours this week, plus last week's (Monday's
// rows are usually Friday's), plus any picked from the dropdown. A row with
// nothing in it can be dismissed; one with hours stays until they are cleared.

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
// Past this share of the budget the bar warns before it is overrun.
const BUDGET_WARN = 0.8

const EMPTY: Hours = { budgets: {}, days: {} }

/** Local YYYY-MM-DD — the store's day key. Never toISOString (that's UTC). */
function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
  return m
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

/** "1.5", "1:30", ".75", "" (= 0); null when it is not an amount of time. */
function parseHours(text: string): number | null {
  const t = text.trim()
  if (!t) return 0
  const hm = /^(\d+):([0-5]?\d)$/.exec(t)
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null
}

/** Hours as a timesheet shows them: no trailing zeros, blank for none. */
function fmt(n: number): string {
  return n ? String(Math.round(n * 100) / 100) : ''
}

/** The seven day keys of the week starting `monday`. */
function weekDays(monday: Date): string[] {
  return DAY_NAMES.map((_, i) => dayKey(addDays(monday, i)))
}

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function HoursPanel() {
  const [open, setOpen] = useState(false)
  const [hours, setHours] = useState<Hours>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [week, setWeek] = useState(() => mondayOf(new Date()))
  // Rows picked from the dropdown, and empty rows dismissed — this session
  // only; anything with hours in it is a row by the store's say-so.
  const [added, setAdded] = useState<string[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const wrap = useDismiss<HTMLDivElement>(open, () => setOpen(false), { escape: true })
  const list = useProjectList()
  // Only active projects are offered; archived ones keep any rows they have.
  const projects = useMemo(
    () => (list?.projects ?? []).filter((name) => !list?.archived.includes(name)),
    [list],
  )

  // A rename re-keys the hours server-side, which publishes `hours` too.
  useEffect(() => {
    const load = () => fetchHours().then(setHours, (err) => setError(errorMessage(err)))
    load()
    const offs = [onEvent('hours', load), onEvent('reconnected', load)]
    return () => offs.forEach((off) => off())
  }, [])

  // Each time the panel opens it starts on the current week.
  useEffect(() => {
    if (open) setWeek(mondayOf(new Date()))
  }, [open])

  const today = dayKey(new Date())
  const thisMonday = mondayOf(new Date())
  const days = useMemo(() => weekDays(week), [week])
  const cell = (date: string, project: string) => hours.days[date]?.[project] ?? 0
  const dayTotal = (date: string) => Object.values(hours.days[date] ?? {}).reduce((a, b) => a + b, 0)
  const weekTotal = (dates: string[]) => dates.reduce((sum, d) => sum + dayTotal(d), 0)

  const rows = useMemo(() => {
    const lastWeek = weekDays(addDays(week, -7))
    const logged = (dates: string[]) => dates.flatMap((d) => Object.keys(hours.days[d] ?? {}))
    const current = new Set(logged(days))
    const carried = logged(lastWeek).filter((p) => !dismissed.includes(p))
    const extra = added.filter((p) => !dismissed.includes(p))
    return [...new Set([...current, ...carried, ...extra])].sort((a, b) => a.localeCompare(b))
  }, [hours, days, week, added, dismissed])

  const totals = useMemo(() => {
    const all: Record<string, number> = {}
    for (const day of Object.values(hours.days)) {
      for (const [p, n] of Object.entries(day)) all[p] = (all[p] ?? 0) + n
    }
    return all
  }, [hours])

  const currentTotal = weekTotal(weekDays(thisMonday))

  const save = (write: Promise<Hours>) =>
    write.then(
      (next) => {
        setHours(next)
        setError(null)
      },
      (err) => setError(errorMessage(err)),
    )

  const addable = projects.filter((p) => !rows.includes(p))
  const span = `${shortDate(week)} – ${shortDate(addDays(week, 6))}`

  return (
    <div className="todo-switch" ref={wrap}>
      <button
        className={open ? 'topbar-button topbar-toggle on' : 'topbar-button topbar-toggle'}
        onClick={() => setOpen(!open)}
        title={open ? 'Close hours' : 'Log billable hours'}
      >
        <span className="topbar-toggle-mark">◷</span>
        <span>Hours</span>
        {currentTotal > 0 && <span className="todo-count">{fmt(currentTotal)}</span>}
      </button>
      {open && (
        <div className="todo-menu hours-menu">
          <div className="todo-head">
            <span className="t">Hours</span>
            <span className="hours-week">
              <button className="hours-nav" title="Previous week" onClick={() => setWeek(addDays(week, -7))}>
                ‹
              </button>
              <span className="hours-span">{span}</span>
              <button className="hours-nav" title="Next week" onClick={() => setWeek(addDays(week, 7))}>
                ›
              </button>
              {dayKey(week) !== dayKey(thisMonday) && (
                <button className="todo-clear hours-today" onClick={() => setWeek(thisMonday)}>
                  This week
                </button>
              )}
            </span>
          </div>
          {error && <div className="todo-error">{error}</div>}
          <div className="hours-grid-wrap">
            <table className="hours-grid">
              <thead>
                <tr>
                  <th className="hours-project">Project</th>
                  {days.map((d, i) => (
                    <th key={d} className={d === today ? 'hours-day today' : 'hours-day'}>
                      {DAY_NAMES[i]}
                      <small>{Number(d.slice(8))}</small>
                    </th>
                  ))}
                  <th className="hours-sum">Week</th>
                  <th className="hours-budget">Budget</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="todo-empty hours-empty">
                      No hours this week.
                    </td>
                  </tr>
                )}
                {rows.map((project) => {
                  const rowWeek = days.reduce((sum, d) => sum + cell(d, project), 0)
                  return (
                    <tr key={project}>
                      <td className="hours-project" title={project}>
                        <div className="hours-project-cell">
                          <span className="hours-name">{project}</span>
                          {rowWeek === 0 && (
                            <RowAction
                              kind="delete"
                              title={`Remove “${project}” from this week`}
                              onClick={() => setDismissed((list) => [...list, project])}
                            />
                          )}
                        </div>
                      </td>
                      {days.map((d) => (
                        <td key={d} className={d === today ? 'today' : undefined}>
                          <HoursCell
                            value={cell(d, project)}
                            label={`${project}, ${d}`}
                            onCommit={(n) => save(setDayHours(d, project, n))}
                          />
                        </td>
                      ))}
                      <td className="hours-sum">{fmt(rowWeek)}</td>
                      <td className="hours-budget">
                        <BudgetCell
                          used={totals[project] ?? 0}
                          budget={hours.budgets[project] ?? 0}
                          onCommit={(n) => save(setBudgetHours(project, n))}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="hours-project">Total</td>
                    {days.map((d) => (
                      <td key={d} className={d === today ? 'today' : undefined}>
                        {fmt(dayTotal(d))}
                      </td>
                    ))}
                    <td className="hours-sum">{fmt(weekTotal(days)) || '0'}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="todo-foot">
            <Select
              value=""
              placeholder={addable.length ? 'Add project…' : 'Every project is listed'}
              options={addable}
              disabled={!addable.length}
              onChange={(p) => {
                if (!p) return
                setAdded((list) => [...list, p])
                setDismissed((list) => list.filter((x) => x !== p))
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** One day's hours: shows the stored value, edits as text, saves on Enter
 *  or blur when it changed. Escape or a bad value puts the stored one back. */
function HoursCell({
  value,
  label,
  onCommit,
}: {
  value: number
  label: string
  onCommit: (hours: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = parseHours(draft)
    setDraft(null)
    if (n !== null && Math.abs(n - value) > 1e-9) onCommit(n)
  }
  const bad = draft !== null && parseHours(draft) === null
  return (
    <input
      className={bad ? 'hours-cell bad' : 'hours-cell'}
      aria-label={label}
      inputMode="decimal"
      value={draft ?? fmt(value)}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        // Escape mid-edit cancels the edit; a second one closes the panel.
        if (e.key === 'Escape' && draft !== null) {
          e.stopPropagation()
          setDraft(null)
        }
      }}
    />
  )
}

/** Used against budget: a bar and "used / budget". Click the budget to set it. */
function BudgetCell({
  used,
  budget,
  onCommit,
}: {
  used: number
  budget: number
  onCommit: (hours: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // Escape unmounts the input, and the blur that follows must not save.
  const cancelled = useRef(false)
  if (draft !== null) {
    const done = () => {
      const n = Number(draft.trim() || 0)
      setDraft(null)
      if (cancelled.current) return
      if (Number.isFinite(n) && n >= 0 && n !== budget) onCommit(n)
    }
    return (
      <input
        className="hours-cell hours-budget-input"
        autoFocus
        inputMode="decimal"
        placeholder="Budget h"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            cancelled.current = true
            setDraft(null)
          }
        }}
      />
    )
  }
  const share = budget ? used / budget : 0
  const tone = !budget ? '' : share > 1 ? 'over' : share >= BUDGET_WARN ? 'warn' : ''
  return (
    <button
      className={`hours-budget-view ${tone}`}
      title={!budget ? 'Set a budget'
        : used > budget ? `${fmt(used - budget)} h over — click to change the budget`
        : `${fmt(budget - used) || 0} h left — click to change the budget`}
      onClick={() => {
        cancelled.current = false
        setDraft(budget ? String(budget) : '')
      }}
    >
      <span className="hours-budget-text">
        {fmt(used) || '0'}
        <span className="of"> / {budget ? fmt(budget) : '—'}</span>
      </span>
      {budget > 0 && (
        <span className="hours-bar">
          <i style={{ width: `${Math.min(share, 1) * 100}%` }} />
        </span>
      )}
    </button>
  )
}
