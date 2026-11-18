// The SEL document library: the manuals, data sheets, application guides and
// ordering documents that live as PDFs on this machine, looked up by device
// model. Backed by /api/sel — so this works inside projector and is simply
// absent in the standalone atlas app, which has no backend. The endpoint
// shapes live here; the fetching is api.ts's, like every other endpoint's.

import { get, send } from '../api'

export interface SelTextHit {
  path: string
  name: string
  /** From the document's cover; null when its cover did not yield one. */
  title: string | null
  folder: string
  /** null for a name match, which opens the document at its start. */
  page: number | null
  /** Page count, on name matches. */
  pages?: number
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
  /** Matched on file name, not page text (Instruction Manuals). */
  byName?: boolean
  error?: string
}

/** One document type in the index — a top-level folder of the library. */
export interface SelFolder {
  folder: string
  documents: number
  pages: number
  /** Searched by file name rather than page text. */
  byName: boolean
}

export interface SelFullTextStatus {
  available: boolean
  folders: SelFolder[]
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

/** Every page of every PDF, or of one document type when `folder` is given.
 *  Empty when no index has been built. */
export async function selText(query: string, folder?: string | null): Promise<SelTextResult> {
  const scope = folder ? `&folder=${encodeURIComponent(folder)}` : ''
  return get<SelTextResult>(`/api/sel/text?q=${encodeURIComponent(query)}${scope}`)
}

/** Short names for the scope row; an unknown folder shows as itself. */
const FOLDER_SHORT: Record<string, string> = {
  'Application Guides': 'App guides',
  'Instruction Manuals': 'Manuals',
  'Data Sheets': 'Data sheets',
  'Ordering Information': 'Ordering',
}

export function folderShort(folder: string): string {
  return FOLDER_SHORT[folder] ?? folder
}

/**
 * Hand the PDF to the OS viewer. `page` asks the viewer to jump there —
 * honoured by Edge, Chrome and Acrobat, ignored harmlessly by anything else.
 */
export async function selOpen(path: string, page?: number | null): Promise<void> {
  await send('/api/sel/open', 'POST', { path, page })
}
