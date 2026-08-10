import type {
  AggregateResult,
  CompareItem,
  CompareTree,
  DeviceSource,
  ProjectItem,
  ProjectList,
  ProjectTree,
  RtacAvailableList,
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

async function get<T>(url: string): Promise<T> {
  return parse(await fetch(url))
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(url, {
    method,
    headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  return parse(res)
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
