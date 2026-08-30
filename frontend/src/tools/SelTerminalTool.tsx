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

import { useEffect, useRef, useState } from 'react'

import {
  closeTerminal,
  fetchToolSettings,
  openTerminal,
  sendTerminalInput,
  terminalStreamUrl,
  updateToolSettings,
  uploadFiles,
} from '../api'
import { Button, Select, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { ToolProps } from './registry'

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

export function SelTerminalTool({ project }: ToolProps) {
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [buffer, setBuffer] = useState('')
  const [line, setLine] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('23')
  const [transport, setTransport] = useState<'telnet' | 'tcp'>('telnet')
  const [saved, setSaved] = useState<SavedConnection[]>([])
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
    fetchToolSettings().then((settings) => {
      if (Array.isArray(settings.terminalConnections)) {
        setSaved(settings.terminalConnections as SavedConnection[])
      }
    }).catch(() => {})
    // Leaving the app (not just switching tools — the pane stays mounted)
    // tears the session down server-side via the stream close.
    return () => {
      streamRef.current?.close()
      if (sessionIdRef.current) closeTerminal(sessionIdRef.current).catch(() => {})
    }
  }, [])

  // Keep the view pinned to the newest output.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [buffer])

  const connect = async () => {
    if (status === 'connecting' || status === 'connected') return
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
    stream.onopen = () => {
      setStatus('connected')
      inputRef.current?.focus()
    }
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
      await updateToolSettings({ terminalConnections: next })
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
      const { added } = await uploadFiles(project, '', [file])
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
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>SEL Terminal</h2>
          <span className={`tool-conn-status is-${status}`}>{STATUS_LABEL[status]}</span>
        </div>
        <div className="preview-subtitle">
          ASCII session to a relay — telnet, or raw TCP for serial-to-Ethernet
          converters. Log in at the prompt (ACC/2AC); the relay's own no-echo
          keeps passwords off the screen. Ctrl+X aborts a streaming report.
        </div>
      </div>
      <div className="tool-fill">
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
    </>
  )
}
