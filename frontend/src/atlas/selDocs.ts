// The SEL document library: the manuals, data sheets, application guides and
// ordering documents that live as PDFs on this machine, looked up by device
// model. Backed by /api/sel — so this works inside projector and is simply
// absent in the standalone atlas app, which has no backend. The endpoint
// shapes live here; the fetching is api.ts's, like every other endpoint's.

import { get, send } from '../api'

export interface SelTextHit {
  path: string
  name: string
  folder: string
  page: number
  snippet: string
  rank: number
}

/** One document type's hits — Instruction Manuals, Application Guides, ... */
export interface SelTextGroup {
  folder: string
  label: string
  hits: SelTextHit[]
}

export interface SelTextResult {
  available: boolean
  /** Grouped by document type, best-matching type first. */
  groups: SelTextGroup[]
  error?: string
}

export interface SelFullTextStatus {
  available: boolean
  file: string | null
  documents: number
  pages: number
  sizeMb: number | null
  error: string | null
}

export interface SelStatus {
  root: string
  rootPresent: boolean
  fullText: SelFullTextStatus
}

export async function selStatus(): Promise<SelStatus> {
  return get<SelStatus>('/api/sel/status')
}

/** One model's instruction manual, as the index names it. */
export interface SelManual {
  path: string
  name: string
}

/**
 * The instruction manual for a device model — null when no index is loaded,
 * no manual names the model, or the PDF itself is not on this machine.
 */
export async function selManual(model: string): Promise<SelManual | null> {
  const body = await get<{ manual: SelManual | null }>(
    `/api/sel/manual?model=${encodeURIComponent(model)}`,
  )
  return body.manual
}

/** The manual itself, streamed inline — hand this URL to a new tab. */
export function selManualUrl(model: string): string {
  return `/api/sel/manual/file?model=${encodeURIComponent(model)}`
}

/** Every page of every PDF. Empty when no index has been built. */
export async function selText(query: string): Promise<SelTextResult> {
  return get<SelTextResult>(`/api/sel/text?q=${encodeURIComponent(query)}`)
}

/**
 * Hand the PDF to the OS viewer. `page` asks the viewer to jump there —
 * honoured by Edge, Chrome and Acrobat, ignored harmlessly by anything else.
 */
export async function selOpen(path: string, page?: number): Promise<void> {
  await send('/api/sel/open', 'POST', { path, page })
}
