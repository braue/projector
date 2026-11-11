import { useMemo, useState } from 'react'

import { errorMessage } from '../lib/errors'
import { projectOptions, useProjectList } from '../lib/projectList'
import { addTodo, clearDone, editTodo, placeTodo, removeTodo, useTodos } from '../lib/todos'
import type { Todo, TodoStatus } from '../types'

import { Button, InlineNameForm, Modal, SegmentedControl, Select, TextArea, TextInput } from './ui'

// The todo board: three columns of cards, dragged between and within them.
// Machine-global like the hours — a card may name a project, but the board
// is not inside one — so it is a takeover pane beside Test / Tools / Atlas.
// The margin's project switcher stays up beside it and scopes it to that
// project's cards; "All" (or no project picked) shows every card.

const COLUMNS: { status: TodoStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'In progress' },
  { status: 'done', label: 'Done' },
]

/** Where a dragged card would land: above `before`, or at the bottom. */
interface DropAt {
  status: TodoStatus
  before: string | null
}

/** Hours as an estimate reads: no trailing zeros. */
const fmtHours = (n: number) => `${Math.round(n * 100) / 100}h`

/** What is left of a card's estimate; null when it has none. Never below 0 —
 *  an overrun shows as its own mark. */
const remaining = (c: Todo) => (c.hours === null ? null : Math.max(c.hours - (c.spent ?? 0), 0))

/** "1.5", "1:30", "" (= none); undefined when it is not an amount of time. */
function parseHours(text: string): number | null | undefined {
  const t = text.trim().replace(/h$/i, '')
  if (!t) return null
  const hm = /^(\d+):([0-5]?\d)$/.exec(t)
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function TodoBoard({ project }: { project: string | null }) {
  const todos = useTodos()
  const projects = useProjectList()
  const [all, setAll] = useState(false)
  // '' = every project.
  const filter = all || !project ? '' : project
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<TodoStatus | null>(null)
  // Remounts the add form after each card, so the next can be typed at once.
  const [addKey, setAddKey] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropAt | null>(null)

  const run = (write: Promise<void>) =>
    write.then(() => setError(null), (err) => setError(errorMessage(err)))

  const shown = useMemo(
    () => (todos ?? []).filter((c) => !filter || c.project === filter),
    [todos, filter],
  )
  const editingCard = todos?.find((c) => c.id === editing) ?? null

  const endDrag = () => {
    setDragId(null)
    setDrop(null)
  }

  const land = (at: DropAt) => {
    const id = dragId
    endDrag()
    if (!id) return
    const card = todos?.find((c) => c.id === id)
    if (!card) return
    // Dropped where it already is: no write.
    const column = (todos ?? []).filter((c) => c.status === at.status)
    const next = column[column.findIndex((c) => c.id === id) + 1]?.id ?? null
    if (card.status === at.status && (at.before === id || at.before === next)) return
    run(placeTodo(id, at.status, at.before))
  }

  return (
    <main className="preview board">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>Todo</h2>
          {project && (
            <SegmentedControl
              value={all ? 'all' : 'project'}
              onChange={(v) => setAll(v === 'all')}
              options={[{ value: 'project', label: project }, { value: 'all', label: 'All' }]}
            />
          )}
        </div>
      </header>

      <div className="board-body">
        {error && <div className="tool-error">{error}</div>}
        <div className="board-cols">
          {COLUMNS.map(({ status, label }) => {
            const cards = shown.filter((c) => c.status === status)
            const hours = cards.reduce((sum, c) => sum + (remaining(c) ?? 0), 0)
            const dropHere = drop?.status === status
            return (
              <section
                key={status}
                className={'board-col' + (dropHere ? ' drop' : '')}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  // Over the column's empty tail: the bottom. Cards set their
                  // own slot and stop the event before it gets here.
                  if (!dropHere || drop.before !== null) setDrop({ status, before: null })
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node) && dropHere) setDrop(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (drop) land(drop)
                }}
              >
                <header className="board-col-head">
                  <span className="t">{label}</span>
                  <span className="n">{cards.length}</span>
                  {hours > 0 && <span className="h">{fmtHours(hours)}</span>}
                  <span className="board-spacer" />
                  {status === 'done' && cards.length > 0 && !filter && (
                    <button className="board-clear" onClick={() => run(clearDone())}>Clear</button>
                  )}
                  <button className="board-add" title="Add" onClick={() => setAdding(status)}>+</button>
                </header>
                <div className="board-cards">
                  {cards.map((card) => (
                    <TodoCard
                      key={card.id}
                      card={card}
                      dragging={dragId === card.id}
                      dropBefore={dropHere && drop.before === card.id}
                      onDragStart={() => setDragId(card.id)}
                      onDragEnd={endDrag}
                      onDragOver={(e) => {
                        if (!dragId) return
                        e.preventDefault()
                        e.stopPropagation()
                        // Top half: above this card. Bottom half: above the next.
                        const box = e.currentTarget.getBoundingClientRect()
                        const below = e.clientY > box.top + box.height / 2
                        const i = cards.indexOf(card)
                        const before = below ? (cards[i + 1]?.id ?? null) : card.id
                        if (!dropHere || drop.before !== before) setDrop({ status, before })
                      }}
                      onOpen={() => setEditing(card.id)}
                    />
                  ))}
                  {dropHere && drop.before === null && <div className="board-slot" />}
                  {adding === status ? (
                    <div className="board-adding">
                      <InlineNameForm
                        key={addKey}
                        placeholder="Title"
                        onCommit={async (title) => {
                          await addTodo({ title, status, project: filter || null })
                          setAddKey((k) => k + 1)
                        }}
                        onCancel={() => setAdding(null)}
                      />
                    </div>
                  ) : (
                    todos !== null && cards.length === 0 && !dropHere && (
                      <div className="board-empty">None.</div>
                    )
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {editingCard && (
        <CardModal
          card={editingCard}
          projects={projectOptions(projects, editingCard.project)}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            await editTodo(editingCard.id, fields)
            setEditing(null)
          }}
          onDelete={async () => {
            await removeTodo(editingCard.id)
            setEditing(null)
          }}
        />
      )}
    </main>
  )
}

function TodoCard({
  card,
  dragging,
  dropBefore,
  onDragStart,
  onDragEnd,
  onDragOver,
  onOpen,
}: {
  card: Todo
  dragging: boolean
  dropBefore: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onOpen: () => void
}) {
  const left = remaining(card)
  const over = card.hours !== null && (card.spent ?? 0) > card.hours
  return (
    <>
      {dropBefore && <div className="board-slot" />}
      <div
        className={'board-card' + (card.status === 'done' ? ' done' : '') + (dragging ? ' dragging' : '')}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', card.title)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onClick={onOpen}
      >
        <div className="board-card-title">{card.title}</div>
        {card.description && <div className="board-card-desc">{card.description}</div>}
        {(card.project || left !== null) && (
          <div className="board-card-foot">
            {card.project && <span className="board-card-project">{card.project}</span>}
            {left !== null && (
              <span className={'board-card-hours' + (over ? ' over' : '')}
                title={`${fmtHours(card.spent ?? 0)} of ${fmtHours(card.hours!)}`}>
                {over ? `+${fmtHours(card.spent! - card.hours!)}` : fmtHours(left)}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function CardModal({
  card,
  projects,
  onClose,
  onSave,
  onDelete,
}: {
  card: Todo
  projects: { value: string; label: string }[]
  onClose: () => void
  onSave: (fields: Partial<Todo>) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description)
  const [project, setProject] = useState(card.project ?? '')
  const [hours, setHours] = useState(card.hours === null ? '' : String(card.hours))
  const [spent, setSpent] = useState(card.spent == null ? '' : String(card.spent))
  const [status, setStatus] = useState<TodoStatus>(card.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedHours = parseHours(hours)
  const parsedSpent = parseHours(spent)
  const valid = title.trim() !== '' && parsedHours !== undefined && parsedSpent !== undefined

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const save = () => {
    if (!valid || busy) return
    act(() => onSave({
      title: title.trim(), description, project: project || null, hours: parsedHours ?? null, spent: parsedSpent ?? null, status,
    }))
  }

  return (
    <Modal title="Card" onClose={onClose} locked={busy} className="board-modal">
      <div
        className="board-form"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
        }}
      >
        <TextInput label="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }} />
        <div className="board-form-row">
          <Select label="Project" value={project} onChange={setProject} placeholder="None" options={projects} />
          <TextInput label="Estimate" className={'ui-input board-hours' + (parsedHours === undefined ? ' bad' : '')}
            value={hours} placeholder="h" onChange={(e) => setHours(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }} />
          <TextInput label="Spent" className={'ui-input board-hours' + (parsedSpent === undefined ? ' bad' : '')}
            value={spent} placeholder="h" onChange={(e) => setSpent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }} />
          <Select label="Status" value={status} onChange={(v) => setStatus(v as TodoStatus)}
            options={COLUMNS.map((c) => ({ value: c.status, label: c.label }))} />
        </div>
        <label className="ui-labeled board-desc">
          <span className="ui-label">Description</span>
          <TextArea rows={8} spellCheck value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-foot">
        <Button className="board-delete" disabled={busy} onClick={() => act(onDelete)}>Delete</Button>
        <Button variant="primary" disabled={!valid || busy} onClick={save}>Save</Button>
      </div>
    </Modal>
  )
}
