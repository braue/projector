// SEL Terminal — live ASCII session to a relay, ported from Volture's
// terminal window. Line-based: the display shows only what the relay
// transmits (its own echo included), so passwords the relay chooses not to
// echo never appear — log in with ACC/2AC at the prompt like on a serial
// cable. Enter sends the line; Up/Down recall history; Ctrl+X sends CAN to
// abort a streaming report.
//
// Transport differs from Volture: output arrives over an SSE stream, input
// goes as one POST per line. The backend closes the relay session when the
// stream detaches, so a lost stream means a fresh session, announced in the
// transcript rather than silently swapped.
//
// Tabs: each one is a whole TerminalSession — its own target, transcript,
// history and relay session. All stay mounted while hidden, so a relay keeps
// streaming into a tab you are not looking at.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  closeTerminal,
  openTerminal,
  sendTerminalInput,
  terminalStreamUrl,
  uploadFiles,
} from '../api'
import { Button, Select, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { saveSettings, setting } from '../lib/settings'
import type { ToolProps } from './registry'
import { ToolHeader } from './ToolHeader'

const MAX_BUFFER_CHARS = 400_000

type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'closed'

interface SavedConnection {
  name: string
  host: string
  port: string
  transport: 'telnet' | 'tcp'
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Disconnected',
}

interface TabState {
  id: number
  label: string
  status: TerminalStatus
}

let nextTabId = 1
const newTab = (): TabState => ({ id: nextTabId++, label: '', status: 'idle' })

export function SelTerminalTool({ project, active }: ToolProps) {
  const [tabs, setTabs] = useState<TabState[]>(() => [newTab()])
  const [activeId, setActiveId] = useState(() => tabs[0].id)
  const [saved, setSaved] = useState<SavedConnection[]>(() => {
    const stored = setting<unknown>('terminalConnections', [])
    return Array.isArray(stored) ? (stored as SavedConnection[]) : []
  })

  const current = tabs.find((t) => t.id === activeId) ?? tabs[0]

  const addTab = () => {
    const tab = newTab()
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }

  // Closing a tab unmounts its session, which closes the relay session.
  // The last tab is replaced rather than leaving an empty pane.
  const closeTab = (id: number) => {
    const i = tabs.findIndex((t) => t.id === id)
    const rest = tabs.filter((t) => t.id !== id)
    const next = rest.length ? rest : [newTab()]
    setTabs(next)
    if (id === activeId) setActiveId(next[Math.min(i, next.length - 1)].id)
  }

  const reportTab = useCallback((id: number, patch: Partial<TabState>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  return (
    <>
      <ToolHeader title="SEL Terminal">
        <span className={`tool-conn-status is-${current.status}`}>{STATUS_LABEL[current.status]}</span>
      </ToolHeader>
      <div className="ui-tabbar term-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === current.id ? 'ui-tab term-tab active' : 'ui-tab term-tab'}
            onClick={() => setActiveId(tab.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
          >
            <span className={`term-tab-dot is-${tab.status}`} />
            {tab.label || 'New session'}
            <button
              className="term-tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="ui-tab term-tab-add" title="New session" onClick={addTab}>
          +
        </button>
      </div>
      {tabs.map((tab) => (
        <TerminalSession
          key={tab.id}
          id={tab.id}
          project={project}
          visible={active && tab.id === current.id}
          hidden={tab.id !== current.id}
          saved={saved}
          setSaved={setSaved}
          onReport={reportTab}
        />
      ))}
    </>
  )
}

function TerminalSession({
  id,
  project,
  visible,
  hidden,
  saved,
  setSaved,
  onReport,
}: {
  id: number
  project: string
  visible: boolean
  hidden: boolean
  saved: SavedConnection[]
  setSaved: (next: SavedConnection[]) => void
  onReport: (id: number, patch: Partial<TabState>) => void
}) {
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [buffer, setBuffer] = useState('')
  const [line, setLine] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('23')
  const [transport, setTransport] = useState<'telnet' | 'tcp'>('telnet')
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const streamRef = useRef<EventSource | null>(null)
  const historyRef = useRef<string[]>([])
  const historyPosRef = useRef(-1)
  const scrollRef = useRef<HTMLPreElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const append = (text: string) => {
    setBuffer((prev) => {
      const next = prev + text
      return next.length > MAX_BUFFER_CHARS ? next.slice(next.length - MAX_BUFFER_CHARS) : next
    })
  }

  useEffect(() => {
    // Leaving the app (not just switching tools — the pane stays mounted)
    // tears the session down server-side via the stream close.
    return () => {
      streamRef.current?.close()
      if (sessionIdRef.current) closeTerminal(sessionIdRef.current).catch(() => {})
    }
  }, [])

  // Keep the view pinned to the newest output — re-pinned on reveal, since
  // a hidden tab cannot scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (el && !hidden) el.scrollTop = el.scrollHeight
  }, [buffer, hidden])

  // After the render that enables the input — focusing it from the stream's
  // open handler ran while it was still disabled, leaving focus on the
  // Connect/Disconnect button for Enter to hit.
  useEffect(() => {
    if (visible && status === 'connected') inputRef.current?.focus()
  }, [visible, status])

  // The tab is named for the relay it was last pointed at.
  const connectedHost = useRef('')
  useEffect(() => {
    onReport(id, { status, label: connectedHost.current })
  }, [id, status, onReport])

  const connect = async () => {
    if (status === 'connecting' || status === 'connected') return
    connectedHost.current = port && port !== '23' ? `${host.trim()}:${port}` : host.trim()
    setStatus('connecting')
    setBuffer('')
    let sessionId: string
    try {
      const opened = await openTerminal({
        host: host.trim(),
        port: Number(port) || undefined,
        transport,
      })
      sessionId = opened.sessionId
    } catch (err) {
      setStatus('closed')
      append(`*** ${errorMessage(err)} ***\r\n`)
      return
    }
    sessionIdRef.current = sessionId
    const stream = new EventSource(terminalStreamUrl(sessionId))
    streamRef.current = stream
    // The banner latch: retries after a broken stream would otherwise fill
    // the transcript. One notice per episode.
    let failureShown = false
    stream.onopen = () => setStatus('connected')
    stream.addEventListener('data', (e) => {
      append(JSON.parse((e as MessageEvent).data))
    })
    stream.addEventListener('closed', (e) => {
      append(`\r\n*** Session closed: ${JSON.parse((e as MessageEvent).data)} ***\r\n`)
      setStatus('closed')
      sessionIdRef.current = null
      stream.close()
    })
    stream.onerror = () => {
      // The backend closes the relay session when the stream drops, so a
      // reconnect would only 404 — stop and let the user reconnect fresh.
      if (!failureShown && sessionIdRef.current) {
        failureShown = true
        append('\r\n*** Output stream lost — session closed ***\r\n')
      }
      setStatus('closed')
      sessionIdRef.current = null
      stream.close()
    }
  }

  const disconnect = () => {
    const sessionId = sessionIdRef.current
    if (sessionId) closeTerminal(sessionId).catch(() => {})
  }

  const sendRaw = (data: string) => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    sendTerminalInput(sessionId, data).catch((err) => {
      append(`\r\n*** ${errorMessage(err)} ***\r\n`)
    })
  }

  const sendLine = () => {
    if (status !== 'connected') return
    const text = line
    if (text.trim()) {
      historyRef.current = [text, ...historyRef.current.filter((h) => h !== text)].slice(0, 50)
    }
    historyPosRef.current = -1
    setLine('')
    sendRaw(`${text}\r\n`)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendLine()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(historyPosRef.current + 1, historyRef.current.length - 1)
      if (next >= 0 && historyRef.current[next] != null) {
        historyPosRef.current = next
        setLine(historyRef.current[next])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = historyPosRef.current - 1
      historyPosRef.current = Math.max(next, -1)
      setLine(next >= 0 ? historyRef.current[next] : '')
    } else if (e.key === 'x' && e.ctrlKey) {
      e.preventDefault()
      sendRaw('\x18') // CAN — abort the report the relay is transmitting.
    }
  }

  const persistSaved = async (next: SavedConnection[]) => {
    setSaved(next)
    try {
      await saveSettings({ terminalConnections: next })
    } catch (err) {
      setSaveStatus(errorMessage(err))
    }
  }

  const currentName = `${host.trim()}:${port || '23'}`
  const saveConnection = () => {
    if (!host.trim()) return
    persistSaved([
      ...saved.filter((s) => s.name !== currentName),
      { name: currentName, host: host.trim(), port, transport },
    ])
  }

  const pickSaved = (name: string) => {
    const conn = saved.find((s) => s.name === name)
    if (!conn) return
    setHost(conn.host)
    setPort(conn.port)
    setTransport(conn.transport)
  }

  const transcriptName = () => {
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
    return `terminal ${host.trim() || 'session'} ${stamp}.txt`
  }

  const saveTranscript = async () => {
    setSaveStatus(null)
    const file = new File([buffer], transcriptName(), { type: 'text/plain' })
    try {
      const { added } = await uploadFiles(project, '', [file], 'terminal transcript')
      setSaveStatus(`Saved to ${project} › Files as ${added[0]}`)
    } catch (err) {
      setSaveStatus(`Save failed: ${errorMessage(err)}`)
    }
  }

  // The filesystem counterpart: hand the transcript to the browser's save
  // flow (the transcript lives only in this pane, not in a tool run).
  const downloadTranscript = () => {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'text/plain' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = transcriptName()
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const live = status === 'connected' || status === 'connecting'
  return (
    <div className="tool-fill" hidden={hidden}>
      <div className="tool-row">
        <TextInput
          label="Host"
          value={host}
          placeholder="10.0.0.5"
          disabled={live}
          onChange={(e) => setHost(e.target.value)}
        />
        <TextInput
          label="Port"
          value={port}
          disabled={live}
          style={{ width: 70 }}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
        />
        <Select
          label="Transport"
          value={transport}
          onChange={(value) => setTransport(value === 'tcp' ? 'tcp' : 'telnet')}
          options={[
            { value: 'telnet', label: 'Telnet' },
            { value: 'tcp', label: 'Raw TCP' },
          ]}
        />
        {live ? (
          <Button onClick={disconnect}>Disconnect</Button>
        ) : (
          <Button variant="primary" disabled={!host.trim()} onClick={connect}>
            Connect
          </Button>
        )}
        {saved.length > 0 && (
          <Select
            label="Saved"
            value=""
            placeholder="Pick…"
            onChange={pickSaved}
            options={saved.map((s) => s.name)}
          />
        )}
        <Button
          disabled={!host.trim() || saved.some((s) => s.name === currentName)}
          onClick={saveConnection}
        >
          Save
        </Button>
      </div>
      {/* One surface, like Volture's window: the transcript with the
          command line flush beneath it — the input is borderless so typing
          reads as typing into the terminal. */}
      <div className="tools-terminal-frame" onClick={() => inputRef.current?.focus()}>
        <pre ref={scrollRef} className="tools-terminal">
          {buffer || (status === 'connecting' ? 'Opening session…' : 'Connect to a relay to start.')}
        </pre>
        <div className="tools-terminal-inputrow">
          <span className="tools-terminal-prompt">&gt;</span>
          <TextInput
            ref={inputRef}
            value={line}
            disabled={status !== 'connected'}
            placeholder={status === 'connected' ? 'Type a command — Enter sends, Ctrl+X aborts output' : ''}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>
      <div className="tool-row">
        <Button disabled={!buffer} onClick={saveTranscript}>Save transcript to project</Button>
        <Button disabled={!buffer} onClick={downloadTranscript}>Download transcript</Button>
        {saveStatus && <span className="tool-status">{saveStatus}</span>}
      </div>
    </div>
  )
}
