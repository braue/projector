// The bench device table as CSV — what gets passed around when the switch's
// wiring changes. One row per device under an Identifier, Kind, Network IP,
// Port header; Kind is RTAC or Other. Reading takes the header in any order
// and case (Excel's BOM and CRLF too) and refuses rows it can't place,
// rather than guessing; the server's checks still run on Save.

import type { BenchDevice } from '../api'

const COLUMNS = [
  { key: 'id', label: 'Identifier', names: ['identifier', 'id'] },
  { key: 'kind', label: 'Kind', names: ['kind', 'type'] },
  { key: 'networkIp', label: 'Network IP', names: ['network ip', 'networkip', 'network_ip', 'ip'] },
  { key: 'port', label: 'Port', names: ['port', 'switch port'] },
] as const

type Row = Pick<BenchDevice, 'id' | 'kind' | 'networkIp' | 'port'>

const quote = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)

export function benchToCsv(devices: Row[]): string {
  const lines: string[][] = [COLUMNS.map((c) => c.label)]
  for (const d of devices) {
    lines.push([d.id, d.kind === 'other' ? 'Other' : 'RTAC', d.networkIp, d.port])
  }
  return lines.map((cells) => cells.map(quote).join(',')).join('\r\n') + '\r\n'
}

/** RFC 4180 cells: quoted fields may hold commas, quotes ("") and newlines. */
function parseCells(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (quoted) throw new Error('unclosed quote in the CSV')
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x.trim()))
}

export function benchFromCsv(text: string): Row[] {
  const [header, ...body] = parseCells(text.replace(/^﻿/, ''))
  if (!header) throw new Error('the CSV is empty')
  const names = header.map((h) => h.trim().toLowerCase())
  const at = Object.fromEntries(COLUMNS.map((c) => [c.key, names.findIndex((n) => (c.names as readonly string[]).includes(n))]))
  const missing = COLUMNS.filter((c) => at[c.key] < 0).map((c) => c.label)
  if (missing.length) throw new Error(`the CSV has no ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}`)
  return body.map((cells, i) => {
    const get = (key: string) => (cells[at[key]] ?? '').trim()
    const kind = get('kind').toLowerCase()
    if (kind && kind !== 'rtac' && kind !== 'other') {
      throw new Error(`row ${i + 2}: kind "${get('kind')}" is not RTAC or Other`)
    }
    return { id: get('id'), kind: kind === 'other' ? 'other' : 'rtac', networkIp: get('networkIp'), port: get('port') }
  })
}
