// Virtual Machines — one card per lab box, double-click to be inside it.
//
// The card IS the record: name, address, user and password sit on its face,
// editable in place, and a double-click anywhere on it opens the RDP session
// with those credentials already filled in (the backend hands them to the
// platform's client — see backend/services/tools/vms.js). Passwords are held
// in the clear on purpose; the reveal toggle is shoulder-surfing courtesy,
// not security.

import { useEffect, useState } from 'react'

import { connectVm, deleteVm, fetchVms, saveVm } from '../api'
import { Button, SectionHeader, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { Vm } from '../types'
import type { ToolProps } from './registry'

type Draft = Omit<Vm, 'id'> & { id?: string }

const BLANK: Draft = { name: '', host: '', username: '', password: '', notes: '' }

// The card in edit mode: the same four fields whether it is new or existing.
function VmForm({
  draft,
  onCancel,
  onSave,
  busy,
}: {
  draft: Draft
  onCancel: () => void
  onSave: (next: Draft) => void
  busy: boolean
}) {
  const [value, setValue] = useState<Draft>(draft)
  const field = (key: keyof Draft) => ({
    value: String(value[key] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setValue((current) => ({ ...current, [key]: e.target.value })),
  })
  const ready = value.name.trim() !== '' && value.host.trim() !== ''

  return (
    <form
      className="vm-card is-editing"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) onSave(value)
      }}
    >
      <TextInput label="Name" placeholder="SIM RTAC 1" autoFocus {...field('name')} />
      <TextInput label="Address" placeholder="10.0.0.5" {...field('host')} />
      <TextInput label="Username" placeholder="Administrator" {...field('username')} />
      {/* type=text: the password is stored in the clear anyway, and a typo
          hidden behind dots is the thing that wastes a connect attempt. */}
      <TextInput label="Password" {...field('password')} />
      <div className="vm-card-actions">
        <Button type="submit" variant="primary" disabled={!ready || busy}>Save</Button>
        <Button type="button" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

function VmCard({
  vm,
  onConnect,
  onEdit,
  onDelete,
  connecting,
  status,
}: {
  vm: Vm
  onConnect: () => void
  onEdit: () => void
  onDelete: () => void
  connecting: boolean
  status: string | null
}) {
  const [shown, setShown] = useState(false)

  return (
    <div
      className="vm-card"
      onDoubleClick={onConnect}
      title={`${vm.name} — double-click to connect`}
    >
      <div className="vm-card-head">
        <span className="vm-card-name">{vm.name}</span>
        {connecting && <Spinner />}
      </div>
      <dl className="vm-card-fields">
        <dt>Address</dt>
        <dd className="mono">{vm.host}</dd>
        <dt>User</dt>
        <dd className="mono">{vm.username || <span className="dim">none</span>}</dd>
        <dt>Password</dt>
        <dd className="mono">
          {vm.password
            ? (shown ? vm.password : '••••••••')
            : <span className="dim">none</span>}
          {vm.password && (
            <button
              type="button"
              className="vm-reveal"
              onClick={() => setShown(!shown)}
              title={shown ? 'Hide' : 'Show'}
            >
              {shown ? 'hide' : 'show'}
            </button>
          )}
        </dd>
      </dl>
      {status && <div className="vm-card-status">{status}</div>}
      <div className="vm-card-actions">
        <Button variant="primary" onClick={onConnect} disabled={connecting}>Connect</Button>
        <Button onClick={onEdit}>Edit</Button>
        <Button onClick={onDelete}>Delete</Button>
      </div>
    </div>
  )
}

export function VmsTool({ active }: ToolProps) {
  const [vms, setVms] = useState<Vm[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  // Per-card launch outcome: what happened to THIS box, beside this box.
  const [status, setStatus] = useState<{ id: string; text: string } | null>(null)

  const load = () => {
    fetchVms()
      .then((next) => {
        setVms(next)
        setError(null)
      })
      .catch((err) => setError(errorMessage(err)))
  }

  // Tools latch-mount and stay mounted while hidden; refreshing when this one
  // comes back to the front keeps the cards current if they were edited from
  // another window.
  useEffect(() => {
    if (active) load()
  }, [active])

  const commit = async (draft: Draft) => {
    setBusy(true)
    try {
      await saveVm(draft)
      setEditing(null)
      load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (vm: Vm) => {
    setBusy(true)
    try {
      await deleteVm(vm.id)
      load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (vm: Vm) => {
    if (connecting) return
    setConnecting(vm.id)
    setStatus(null)
    try {
      const result = await connectVm(vm.id)
      setStatus({ id: vm.id, text: `Opened ${result.address} with ${result.client}.` })
    } catch (err) {
      setStatus({ id: vm.id, text: errorMessage(err) })
    } finally {
      setConnecting(null)
    }
  }

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>Virtual Machines</h2>
          {busy && <Spinner />}
        </div>
        <div className="preview-subtitle">
          Double-click a card to open its Remote Desktop session.
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader
          title="Machines"
          count={vms ? `${vms.length}` : undefined}
        />
        {error && <div className="tool-error">{error}</div>}

        <div className="vm-grid">
          {vms?.map((vm) =>
            editing === vm.id ? (
              <VmForm
                key={vm.id}
                draft={vm}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={commit}
              />
            ) : (
              <VmCard
                key={vm.id}
                vm={vm}
                connecting={connecting === vm.id}
                status={status?.id === vm.id ? status.text : null}
                onConnect={() => connect(vm)}
                onEdit={() => setEditing(vm.id)}
                onDelete={() => remove(vm)}
              />
            ),
          )}

          {editing === 'new' ? (
            <VmForm
              draft={BLANK}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={commit}
            />
          ) : (
            <button className="vm-card vm-card-add" onClick={() => setEditing('new')}>
              <span className="vm-add-plus">+</span>
              Add a machine
            </button>
          )}
        </div>

        {vms !== null && vms.length === 0 && editing !== 'new' && (
          <div className="tool-empty">No machines yet — add one and it stays here.</div>
        )}
      </div>
    </>
  )
}
