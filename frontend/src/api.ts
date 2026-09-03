import type {
  AggregateResult,
  ArtifactProfile,
  CompareItem,
  CompareTree,
  DwgenResult,
  FileNode,
  HmiReport,
  ProjectItem,
  ProjectTree,
  QuicksetExtract,
  QuicksetInventory,
  RtacAvailableList,
  RtacExportStatus,
  SearchResults,
  SwsetGenerateResult,
  SwsetModel,
  Todo,
  ToolJob,
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

/**
 * The todo list — machine-global, not project state. It lives in the data
 * directory rather than localStorage because the packaged app listens on port
 * 0, so its origin changes every launch and browser-side storage does not
 * survive a restart.
 */
export async function listTodos(): Promise<Todo[]> {
  return (await get<{ todos: Todo[] }>('/api/todos')).todos
}

/** Whole-list replace — order is the user's, so it is sent as given. */
export async function saveTodos(todos: Todo[]): Promise<Todo[]> {
  return (await send<{ todos: Todo[] }>('/api/todos', 'PUT', { todos })).todos
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

// --- RTAC intake (the machine-global catalog, exported into the tree) ----------

/** The machine-global AcRTAC catalog (the database browser's list). */
export function fetchRtacAvailable(project: string): Promise<RtacAvailableList> {
  return get(`${base(project)}/artifacts/rtac/available`)
}

/** Re-query the database list, then return the catalog. */
export function refreshRtacAvailable(project: string): Promise<RtacAvailableList> {
  return send(`${base(project)}/artifacts/rtac/refresh`, 'POST')
}

/** Download a database project into `dir` as <name>.rtac — a NEW VERSION when
 * that entry already exists there. `into` targets an existing .rtac entry by
 * name instead (versioning a renamed export). Completion is polled via the
 * status list. */
export async function startRtacExport(
  project: string,
  dir: string,
  name: string,
  note: string,
  into?: string,
): Promise<void> {
  await send(`${base(project)}/artifacts/rtac/export`, 'POST', { dir, name, note, into })
}

/** In-flight and failed exports, overlaid on the tree while they run. */
export async function fetchRtacStatus(project: string): Promise<RtacExportStatus[]> {
  return (await get<{ exports: RtacExportStatus[] }>(`${base(project)}/artifacts/rtac/status`)).exports
}

/** Dismiss one failed export from the overlay. */
export function dismissRtacError(project: string, path: string): Promise<unknown> {
  return send(`${base(project)}/artifacts/rtac/status?path=${encodeURIComponent(path)}`, 'DELETE')
}

/** Upload an exported RTAC XML folder into `dir`. Multer basenames filenames,
 * so the folder-relative paths ride in a parallel field, index-aligned. */
export function uploadRtacFolder(
  project: string,
  dir: string,
  files: File[],
  note: string,
): Promise<{ added: { path: string; files: number }[] }> {
  const form = new FormData()
  form.append('dir', dir)
  form.append('note', note)
  form.append(
    'paths',
    JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)),
  )
  for (const file of files) {
    form.append('files', file)
  }
  return send(`${base(project)}/artifacts/rtac/upload`, 'POST', form)
}

/** Aggregate a list of setting names across one RTAC export's objects. */
export function aggregateSettings(
  project: string,
  path: string,
  terms: string[],
  files: string[],
): Promise<AggregateResult> {
  return send(`${base(project)}/artifacts/aggregate`, 'POST', { path, terms, files })
}

// --- compare ------------------------------------------------------------------
// Refs address artifacts by tree path ("a.rdb", "dir/x.scd::IED_1", or an
// archived version's ".versions/…" path); the kind is derived server-side.

function comparePair(original: string, updated: string): string {
  return `original=${encodeURIComponent(original)}&updated=${encodeURIComponent(updated)}`
}

export function fetchCompareTree(
  project: string,
  original: string,
  updated: string,
): Promise<CompareTree> {
  return get(`${base(project)}/compare/tree?${comparePair(original, updated)}`)
}

export function fetchCompareItem(
  project: string,
  original: string,
  updated: string,
  file: string,
): Promise<CompareItem> {
  return get(`${base(project)}/compare/item?${comparePair(original, updated)}&file=${encodeURIComponent(file)}`)
}

// --- project files -------------------------------------------------------------
// Entry paths are store-relative with forward slashes ('' = the root).

export async function listFiles(project: string): Promise<FileNode[]> {
  const body = await get<{ tree: FileNode[] }>(`${base(project)}/files`)
  return body.tree
}

/** Upload into `dir`, stamped with the batch's version note. A name already
 * present there becomes that entry's NEW VERSION (old bytes archived). */
export function uploadFiles(
  project: string,
  dir: string,
  files: File[],
  note: string,
  /** Existing entry this (single-file) upload supersedes — the entry takes
   *  the uploaded file's name, its history riding along. */
  versionOf?: string,
): Promise<{ added: string[] }> {
  const form = new FormData()
  form.append('dir', dir)
  form.append('note', note)
  if (versionOf) form.append('versionOf', versionOf)
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

/** Show an entry ('' = the project root) in the OS file manager. */
export function revealFileEntry(project: string, path: string): Promise<unknown> {
  return send(`${base(project)}/files/reveal`, 'POST', { path })
}

/** Commit a working copy's in-place edits (Excel saving over the live file)
 * as a NEW VERSION — the pre-edit snapshot archives as the superseded
 * version, under the mandatory note. */
export function recordFileEdit(project: string, path: string, note: string): Promise<unknown> {
  return send(`${base(project)}/files/record-edit`, 'POST', { path, note })
}

/** Throw the in-place edits away: restore the pre-edit snapshot. */
export function discardFileEdit(project: string, path: string): Promise<unknown> {
  return send(`${base(project)}/files/discard-edit`, 'POST', { path })
}

/** A text file's content, for the built-in editor. */
export async function readTextFile(project: string, path: string): Promise<string> {
  return (await get<{ text: string }>(`${base(project)}/files/text?path=${encodeURIComponent(path)}`)).text
}

/** Save a text file in place (creates it when new). Not a version. */
export function saveTextFile(project: string, path: string, text: string): Promise<unknown> {
  return send(`${base(project)}/files/text`, 'PUT', { path, text })
}

// --- artifacts (inspect) --------------------------------------------------------

/** The profiles inside one artifact (RDB relays, SCD IEDs, the one switch). */
export async function fetchArtifactProfiles(project: string, path: string): Promise<ArtifactProfile[]> {
  const body = await get<{ profiles: ArtifactProfile[] }>(
    `${base(project)}/artifacts/profiles?path=${encodeURIComponent(path)}`,
  )
  return body.profiles
}

export function fetchArtifactTree(project: string, ref: string): Promise<ProjectTree> {
  return get(`${base(project)}/artifacts/tree?ref=${encodeURIComponent(ref)}`)
}

export function fetchArtifactItem(project: string, ref: string, file: string): Promise<ProjectItem> {
  return get(
    `${base(project)}/artifacts/item?ref=${encodeURIComponent(ref)}&file=${encodeURIComponent(file)}`,
  )
}

// --- search -------------------------------------------------------------------

/** Search one artifact's parsed items (names, settings, points, tables, logic). */
export function searchArtifact(project: string, ref: string, query: string): Promise<SearchResults> {
  const params = new URLSearchParams({ ref, q: query })
  return get(`${base(project)}/search?${params}`)
}

// --- tools (global utilities beside the projects) ------------------------------

const toolRun = (tool: string, run: string) =>
  `/api/tools/${encodeURIComponent(tool)}/runs/${encodeURIComponent(run)}`

export function fetchToolJob(id: string): Promise<ToolJob> {
  return get(`/api/tools/jobs/${encodeURIComponent(id)}`)
}

/** Browser-navigable download URL for one run output file. */
export function toolRunFileUrl(tool: string, run: string, path: string): string {
  return `${toolRun(tool, run)}/file?path=${encodeURIComponent(path)}`
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

// --- DAC SIM Converter ----------------------------------------------------------

/** The whole pipeline as one job: stage the picked DAC exports (settings.json
 * is generated server-side), convert, and land the simulator projects back
 * in the project's tree. `masterIp` is one address for the whole run. */
export function generateDacsim(project: string, payload: {
  schemes: {
    schemeName: string
    dacPath: string
    dacIps: string[]
    remoteIp: string
  }[]
  masterIp: string
}): Promise<{ job: string; run: string }> {
  return send('/api/tools/dacsim/generate', 'POST', { project, ...payload })
}

// --- AcRTAC actions (the project tree's actions on an RTAC entry) ---------------

/** Import one RTAC tree entry into the AcRTAC database, as a pollable job. */
export function startAcrtacImport(project: string, payload: {
  /** Tree path of the .rtac entry. */
  path: string
  /** What the database project will be called. */
  name: string
  deviceType: string
  firmware: string
}): Promise<{ job: string }> {
  return send('/api/tools/acrtac/import', 'POST', { project, ...payload })
}

/** Launch the AcSELerator RTAC GUI on the database project called `name`,
 *  as a pollable job (double-click on an RTAC tree entry). */
export function startAcrtacOpen(name: string): Promise<{ job: string }> {
  return send('/api/tools/acrtac/open', 'POST', { name })
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

