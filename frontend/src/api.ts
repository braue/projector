import type {
  AggregateResult,
  CompareItem,
  CompareTree,
  DeviceSource,
  DwgenResult,
  FileNode,
  HmiReport,
  Note,
  ProjectItem,
  ProjectList,
  ProjectTree,
  QuicksetExtract,
  QuicksetInventory,
  RtacAvailableList,
  SearchResults,
  SwsetGenerateResult,
  SwsetModel,
  ToolJob,
  ToolRunFile,
  UploadSourceType,
  UploadedFile,
  WorkspaceGraph,
} from './types'

// Every endpoint speaks JSON, including failures: { error } with a status.
async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export async function get<T>(url: string): Promise<T> {
  return parse(await fetch(url))
}

export async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(url, {
    method,
    headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  return parse(res)
}

/** The running build, shown in the project menu. Null when the server predates it. */
export async function appVersion(): Promise<string | null> {
  const health = await get<{ ok: boolean; version?: string | null }>('/api/health')
  return health.version ?? null
}

// Everything except the project list itself is scoped to one project.
const base = (project: string) => `/api/projects/${encodeURIComponent(project)}`

// --- projects -----------------------------------------------------------------

export async function listProjects(): Promise<string[]> {
  const body = await get<{ projects: string[] }>('/api/projects')
  return body.projects
}

export function createProject(name: string): Promise<{ name: string }> {
  return send('/api/projects', 'POST', { name })
}

/** Delete a project and everything in it (sources, canvas). */
export function deleteProject(name: string): Promise<unknown> {
  return send(`/api/projects/${encodeURIComponent(name)}`, 'DELETE')
}

export function renameProject(name: string, nextName: string): Promise<{ name: string }> {
  return send(`/api/projects/${encodeURIComponent(name)}`, 'PATCH', { name: nextName })
}

// --- RTAC (the machine-global catalog, exported per project) -------------------

/** The RTAC exports in this project (the sidebar list). */
export function listRtacProjects(project: string): Promise<ProjectList> {
  return get(`${base(project)}/rtac`)
}

/** The machine-global AcRTAC catalog (the database browser's list). */
export function fetchRtacAvailable(project: string): Promise<RtacAvailableList> {
  return get(`${base(project)}/rtac/available`)
}

/** Re-query the database list, then return the catalog. */
export function refreshRtacAvailable(project: string): Promise<RtacAvailableList> {
  return send(`${base(project)}/rtac/refresh`, 'POST')
}

export async function startExport(project: string, name: string): Promise<void> {
  await send(`${base(project)}/rtac/${encodeURIComponent(name)}/export`, 'POST')
}

/** The export names a folder upload will create — the backend groups by the
 * top path segment of each .xml (services/rtac.js uploadFolder; keep the two
 * in step). Feeds the overwrite confirmation before uploadRtacFolder. */
export function rtacExportNames(files: File[]): string[] {
  return [...new Set(files
    .map((file) => (file.webkitRelativePath || file.name)
      .split(/[\\/]/)
      .filter((segment) => segment && segment !== '.' && segment !== '..'))
    .filter((segments) => segments.length >= 2 && /\.xml$/i.test(segments[segments.length - 1]))
    .map((segments) => segments[0]))]
}

/** Upload an exported RTAC XML folder. Multer basenames filenames, so the
 * folder-relative paths ride in a parallel field, index-aligned. */
export function uploadRtacFolder(
  project: string,
  files: File[],
): Promise<{ added: { name: string; files: number }[] }> {
  const form = new FormData()
  form.append(
    'paths',
    JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)),
  )
  for (const file of files) {
    form.append('files', file)
  }
  return send(`${base(project)}/rtac/upload`, 'POST', form)
}

export function deleteRtacExport(project: string, name: string): Promise<unknown> {
  return send(`${base(project)}/rtac/${encodeURIComponent(name)}`, 'DELETE')
}

/** Rename an export. The name is the ref — the backend rewrites canvas refs. */
export function renameRtacExport(
  project: string,
  name: string,
  nextName: string,
): Promise<{ name: string }> {
  return send(`${base(project)}/rtac/${encodeURIComponent(name)}`, 'PATCH', { name: nextName })
}

export function aggregateSettings(
  project: string,
  name: string,
  terms: string[],
  files: string[],
): Promise<AggregateResult> {
  return send(`${base(project)}/rtac/${encodeURIComponent(name)}/aggregate`, 'POST', { terms, files })
}

// --- compare ------------------------------------------------------------------

function comparePair(original: DeviceSource, updated: DeviceSource): string {
  return `originalType=${encodeURIComponent(original.type)}&original=${encodeURIComponent(original.ref)}`
    + `&updatedType=${encodeURIComponent(updated.type)}&updated=${encodeURIComponent(updated.ref)}`
}

export function fetchCompareTree(
  project: string,
  original: DeviceSource,
  updated: DeviceSource,
): Promise<CompareTree> {
  return get(`${base(project)}/compare/tree?${comparePair(original, updated)}`)
}

export function fetchCompareItem(
  project: string,
  original: DeviceSource,
  updated: DeviceSource,
  file: string,
): Promise<CompareItem> {
  return get(`${base(project)}/compare/item?${comparePair(original, updated)}&file=${encodeURIComponent(file)}`)
}

// --- uploads (rdb, scd, sw — same route shapes) --------------------------------

export async function listUploads(project: string, type: UploadSourceType): Promise<UploadedFile[]> {
  const body = await get<{ files: UploadedFile[] }>(`${base(project)}/${type}`)
  return body.files
}

export function uploadSourceFile(
  project: string,
  type: UploadSourceType,
  file: File,
): Promise<UploadedFile> {
  const form = new FormData()
  form.append('file', file)
  return send(`${base(project)}/${type}`, 'POST', form)
}

export function deleteUpload(project: string, type: UploadSourceType, id: string): Promise<unknown> {
  return send(`${base(project)}/${type}/${encodeURIComponent(id)}`, 'DELETE')
}

/** Rename an upload: display name and id together; canvas refs follow. */
export function renameUpload(
  project: string,
  type: UploadSourceType,
  id: string,
  name: string,
): Promise<UploadedFile & { previousId: string }> {
  return send(`${base(project)}/${type}/${encodeURIComponent(id)}`, 'PATCH', { name })
}

// --- notes --------------------------------------------------------------------

export async function listNotes(project: string): Promise<Note[]> {
  const body = await get<{ notes: Note[] }>(`${base(project)}/notes`)
  return body.notes
}

export function createNote(project: string, name: string): Promise<Note> {
  return send(`${base(project)}/notes`, 'POST', { name })
}

export function renameNote(project: string, id: string, name: string): Promise<Note> {
  return send(`${base(project)}/notes/${encodeURIComponent(id)}`, 'PATCH', { name })
}

export function saveNoteText(project: string, id: string, text: string): Promise<Note> {
  return send(`${base(project)}/notes/${encodeURIComponent(id)}/text`, 'PUT', { text })
}

export function deleteNote(project: string, id: string): Promise<unknown> {
  return send(`${base(project)}/notes/${encodeURIComponent(id)}`, 'DELETE')
}

// --- project files -------------------------------------------------------------
// Entry paths are store-relative with forward slashes ('' = the root).

export async function listFiles(project: string): Promise<FileNode[]> {
  const body = await get<{ tree: FileNode[] }>(`${base(project)}/files`)
  return body.tree
}

export function uploadFiles(project: string, dir: string, files: File[]): Promise<{ added: string[] }> {
  const form = new FormData()
  form.append('dir', dir)
  for (const file of files) form.append('files', file)
  return send(`${base(project)}/files/upload`, 'POST', form)
}

export function createFileFolder(project: string, dir: string, name: string): Promise<unknown> {
  return send(`${base(project)}/files/folder`, 'POST', { dir, name })
}

export function renameFileEntry(project: string, path: string, name: string): Promise<unknown> {
  return send(`${base(project)}/files/entry`, 'PATCH', { path, name })
}

export function moveFileEntry(project: string, path: string, to: string): Promise<unknown> {
  return send(`${base(project)}/files/move`, 'POST', { path, to })
}

export function deleteFileEntry(project: string, path: string): Promise<unknown> {
  return send(`${base(project)}/files/entry?path=${encodeURIComponent(path)}`, 'DELETE')
}

/** Open the file with the OS default app (the backend runs on this machine). */
export function openFileEntry(project: string, path: string): Promise<unknown> {
  return send(`${base(project)}/files/open`, 'POST', { path })
}

// Inspect works for any source type — same shapes, per-type endpoints. RTAC
// refs are a path segment; upload-backed types (rdb, scd, sw) share the ?ref=
// route shape.
function inspectUrl(project: string, source: DeviceSource, leaf: string, query?: Record<string, string>): string {
  const params = new URLSearchParams(source.type === 'rtac' ? query : { ref: source.ref, ...query })
  const path = source.type === 'rtac'
    ? `${base(project)}/rtac/${encodeURIComponent(source.ref)}/${leaf}`
    : `${base(project)}/${source.type}/${leaf}`
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export function fetchSourceTree(project: string, source: DeviceSource): Promise<ProjectTree> {
  return get(inspectUrl(project, source, 'tree'))
}

export function fetchSourceItem(
  project: string,
  source: DeviceSource,
  file: string,
): Promise<ProjectItem> {
  return get(inspectUrl(project, source, 'item', { file }))
}

// --- search -------------------------------------------------------------------

/** Search one source's parsed items (names, settings, points, tables, logic). */
export function searchSource(project: string, source: DeviceSource, query: string): Promise<SearchResults> {
  const params = new URLSearchParams({ type: source.type, ref: source.ref, q: query })
  return get(`${base(project)}/search?${params}`)
}

// --- canvas -------------------------------------------------------------------

export function fetchGraph(project: string): Promise<WorkspaceGraph> {
  return get(`${base(project)}/graph`)
}

export function placeDevice(
  project: string,
  source: DeviceSource,
  x: number,
  y: number,
): Promise<{ id: string }> {
  return send(`${base(project)}/devices`, 'POST', { source, x, y })
}

export function moveDevice(project: string, deviceId: string, x: number, y: number): Promise<unknown> {
  return send(`${base(project)}/devices/${encodeURIComponent(deviceId)}`, 'PATCH', { x, y })
}

export function removeDevice(project: string, deviceId: string): Promise<unknown> {
  return send(`${base(project)}/devices/${encodeURIComponent(deviceId)}`, 'DELETE')
}

export function attachScd(project: string, deviceId: string, ref: string): Promise<unknown> {
  return send(`${base(project)}/devices/${encodeURIComponent(deviceId)}/scd`, 'POST', { ref })
}

export function detachScd(project: string, deviceId: string): Promise<unknown> {
  return send(`${base(project)}/devices/${encodeURIComponent(deviceId)}/scd`, 'DELETE')
}

/** Draw a connection between two placed devices: an ethernet port run
 * (aPort/bPort) or a serial pair (aEndpointId/bEndpointId). */
export function addManualLink(
  project: string,
  link: {
    type: 'ethernet' | 'serial'
    aDeviceId: string
    bDeviceId: string
    aPort?: string
    bPort?: string
    aEndpointId?: string
    bEndpointId?: string
  },
): Promise<{ id: string }> {
  return send(`${base(project)}/links`, 'POST', link)
}

export function removeManualLink(project: string, linkId: string): Promise<unknown> {
  return send(`${base(project)}/links/${encodeURIComponent(linkId)}`, 'DELETE')
}

/** Acknowledge a conflicting link: record why the disagreement is acceptable. */
export function addWaiver(project: string, linkId: string, reason: string): Promise<{ id: string }> {
  return send(`${base(project)}/waivers`, 'POST', { linkId, reason })
}

/** Reopen an acknowledged conflict. */
export function removeWaiver(project: string, waiverId: string): Promise<unknown> {
  return send(`${base(project)}/waivers/${encodeURIComponent(waiverId)}`, 'DELETE')
}

// --- tools (global utilities beside the projects) ------------------------------

const toolRun = (tool: string, run: string) =>
  `/api/tools/${encodeURIComponent(tool)}/runs/${encodeURIComponent(run)}`

export function fetchToolJob(id: string): Promise<ToolJob> {
  return get(`/api/tools/jobs/${encodeURIComponent(id)}`)
}

export async function listToolRunFiles(tool: string, run: string): Promise<ToolRunFile[]> {
  const body = await get<{ files: ToolRunFile[] }>(`${toolRun(tool, run)}/files`)
  return body.files
}

/** Browser-navigable download URL for one run output file. */
export function toolRunFileUrl(tool: string, run: string, path: string): string {
  return `${toolRun(tool, run)}/file?path=${encodeURIComponent(path)}`
}

export function deleteToolRun(tool: string, run: string): Promise<unknown> {
  return send(toolRun(tool, run), 'DELETE')
}

/** Copy one run output into a project's Files store (never overwrites). */
export function saveToolFileToProject(args: {
  project: string
  tool: string
  run: string
  path: string
  /** Target folder inside the project's files ('' = root). */
  dir?: string
  /** Stored name; defaults to the file's own basename. */
  name?: string
}): Promise<{ added: string[] }> {
  return send('/api/tools/save-to-project', 'POST', args)
}

/** Machine-specific tool settings (paths, preferences — never credentials). */
export function fetchToolSettings(): Promise<Record<string, unknown>> {
  return get('/api/tools/settings')
}

export function updateToolSettings(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return send('/api/tools/settings', 'PATCH', patch)
}

/** Run the HMI Tag Tester over one uploaded .hprj/.hprb. */
export function analyzeHmi(file: File): Promise<HmiReport> {
  const form = new FormData()
  form.append('file', file)
  return send('/api/tools/hmi/analyze', 'POST', form)
}

// --- SEL terminal --------------------------------------------------------------

/** Open a relay session; the id feeds the stream/input/close calls below. */
export function openTerminal(args: {
  host: string
  port?: number
  transport?: 'telnet' | 'tcp'
}): Promise<{ sessionId: string }> {
  return send('/api/tools/terminal/open', 'POST', args)
}

/** The SSE stream of relay output: `data` events (JSON string payloads) until
 * a `closed` event carries the reason. */
export function terminalStreamUrl(sessionId: string): string {
  return `/api/tools/terminal/${encodeURIComponent(sessionId)}/stream`
}

export function sendTerminalInput(sessionId: string, data: string): Promise<unknown> {
  return send(`/api/tools/terminal/${encodeURIComponent(sessionId)}/input`, 'POST', { data })
}

export function closeTerminal(sessionId: string): Promise<unknown> {
  return send(`/api/tools/terminal/${encodeURIComponent(sessionId)}/close`, 'POST')
}

// --- QuickSet Extract ----------------------------------------------------------

/** Start the database dump job; poll the returned job id, then use the run. */
export function startQuicksetDump(config: {
  host: string
  port?: number
  dbname: string
  user: string
  password: string
}): Promise<{ job: string; run: string }> {
  return send('/api/tools/quickset/dump', 'POST', config)
}

/** Alternative source: an uploaded ZIP of an exported-configs tree. */
export function uploadQuicksetConfigs(file: File): Promise<{ run: string }> {
  const form = new FormData()
  form.append('file', file)
  return send('/api/tools/quickset/upload', 'POST', form)
}

export function fetchQuicksetInventory(run: string): Promise<QuicksetInventory> {
  return get(`/api/tools/quickset/${encodeURIComponent(run)}/inventory`)
}

export function extractQuicksetSettings(
  run: string,
  settings: string[],
): Promise<QuicksetExtract> {
  return send(`/api/tools/quickset/${encodeURIComponent(run)}/extract`, 'POST', { settings })
}

// --- SWSET (switch settings editor) --------------------------------------------

/** Parse a switch Configuration XML into the editable model. */
export function parseSwsetXml(file: File): Promise<SwsetModel> {
  const form = new FormData()
  form.append('file', file)
  return send('/api/tools/swset/parse', 'POST', form)
}

/** Apply edited values onto the run's baseline; the updated XML lands in the run. */
export function generateSwsetXml(
  run: string,
  tables: Record<string, { fields?: Record<string, string>; rows?: Record<string, string>[] }>,
): Promise<SwsetGenerateResult> {
  return send(`/api/tools/swset/${encodeURIComponent(run)}/generate`, 'POST', { tables })
}

// --- RTAC Exporter -------------------------------------------------------------

/** List the AcRTAC database's projects (the bridge logs in itself). */
export async function listRtacExportProjects(): Promise<string[]> {
  const body = await send<{ projects: string[] }>('/api/tools/rtac-export/projects', 'POST')
  return body.projects
}

/** Start the bulk export job; poll the job id for results. */
export function startRtacExportJob(args: {
  projects: string[]
  format: 'xml' | 'exp'
  projectPassword?: string
}): Promise<{ job: string; run: string }> {
  return send('/api/tools/rtac-export/export', 'POST', args)
}

// --- DWGEN (drawing generator) -------------------------------------------------

export async function fetchDwgenModels(): Promise<string[]> {
  const body = await get<{ models: string[] }>('/api/tools/dwgen/models')
  return body.models
}

/** Generate the configured drawings for a part number (model auto-detected). */
export function generateDwgen(args: { partNumber: string; model?: string }): Promise<DwgenResult> {
  return send('/api/tools/dwgen/generate', 'POST', args)
}

/** Launch local AutoCAD on a run's bundled drawing with its layer script. */
export function openDwgenDwg(args: { run: string; stem: string }): Promise<{ ok: boolean; configured: string }> {
  return send('/api/tools/dwgen/open-dwg', 'POST', args)
}

// --- tool inputs from project Files --------------------------------------------
// The analyze/parse/upload endpoints accept { project, path } naming a file
// already in a project's Files store, as the alternative to a fresh upload.

export function analyzeHmiProjectFile(project: string, path: string): Promise<HmiReport> {
  return send('/api/tools/hmi/analyze', 'POST', { project, path })
}

export function parseSwsetProjectFile(project: string, path: string): Promise<SwsetModel> {
  return send('/api/tools/swset/parse', 'POST', { project, path })
}

export function importQuicksetProjectConfigs(project: string, path: string): Promise<{ run: string }> {
  return send('/api/tools/quickset/upload', 'POST', { project, path })
}
