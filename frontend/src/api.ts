import type {
  AggregateResult,
  CompareItem,
  CompareTree,
  DeviceSource,
  ProjectItem,
  ProjectList,
  ProjectTree,
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

export function listProjects(): Promise<ProjectList> {
  return get('/api/projects')
}

// Retry the database list after a failure.
export function refreshProjects(): Promise<ProjectList> {
  return send('/api/projects/refresh', 'POST')
}

export async function startExport(name: string): Promise<void> {
  await send(`/api/projects/${encodeURIComponent(name)}/export`, 'POST')
}

export function fetchTree(name: string): Promise<ProjectTree> {
  return get(`/api/projects/${encodeURIComponent(name)}/tree`)
}

export function fetchItem(name: string, file: string): Promise<ProjectItem> {
  return get(`/api/projects/${encodeURIComponent(name)}/item?file=${encodeURIComponent(file)}`)
}

function comparePair(original: DeviceSource, updated: DeviceSource): string {
  return `originalType=${encodeURIComponent(original.type)}&original=${encodeURIComponent(original.ref)}`
    + `&updatedType=${encodeURIComponent(updated.type)}&updated=${encodeURIComponent(updated.ref)}`
}

export function fetchCompareTree(original: DeviceSource, updated: DeviceSource): Promise<CompareTree> {
  return get(`/api/compare/tree?${comparePair(original, updated)}`)
}

export function fetchCompareItem(
  original: DeviceSource,
  updated: DeviceSource,
  file: string,
): Promise<CompareItem> {
  return get(`/api/compare/item?${comparePair(original, updated)}&file=${encodeURIComponent(file)}`)
}

export function aggregateSettings(
  name: string,
  terms: string[],
  files: string[],
): Promise<AggregateResult> {
  return send(`/api/projects/${encodeURIComponent(name)}/aggregate`, 'POST', { terms, files })
}

// --- uploads (rdb, scd — same route shapes) -----------------------------------

export async function listUploads(type: UploadSourceType): Promise<UploadedFile[]> {
  const body = await get<{ files: UploadedFile[] }>(`/api/${type}`)
  return body.files
}

export function uploadSourceFile(type: UploadSourceType, file: File): Promise<UploadedFile> {
  const form = new FormData()
  form.append('file', file)
  return send(`/api/${type}`, 'POST', form)
}

export function deleteUpload(type: UploadSourceType, id: string): Promise<unknown> {
  return send(`/api/${type}/${encodeURIComponent(id)}`, 'DELETE')
}

// Inspect works for any source type — same shapes, per-type endpoints.
export function fetchSourceTree(source: DeviceSource): Promise<ProjectTree> {
  if (source.type === 'rdb' || source.type === 'scd') {
    return get(`/api/${source.type}/tree?ref=${encodeURIComponent(source.ref)}`)
  }
  return fetchTree(source.ref)
}

export function fetchSourceItem(source: DeviceSource, file: string): Promise<ProjectItem> {
  if (source.type === 'rdb' || source.type === 'scd') {
    return get(`/api/${source.type}/item?ref=${encodeURIComponent(source.ref)}&file=${encodeURIComponent(file)}`)
  }
  return fetchItem(source.ref, file)
}

// --- workspaces / canvas ------------------------------------------------------

export async function listWorkspaces(): Promise<string[]> {
  const body = await get<{ workspaces: string[] }>('/api/workspaces')
  return body.workspaces
}

export function createWorkspace(name: string): Promise<{ name: string }> {
  return send('/api/workspaces', 'POST', { name })
}

export function fetchGraph(workspace: string): Promise<WorkspaceGraph> {
  return get(`/api/workspaces/${encodeURIComponent(workspace)}/graph`)
}

export function placeDevice(
  workspace: string,
  source: DeviceSource,
  x: number,
  y: number,
): Promise<{ id: string }> {
  return send(`/api/workspaces/${encodeURIComponent(workspace)}/devices`, 'POST', { source, x, y })
}

export function moveDevice(
  workspace: string,
  deviceId: string,
  x: number,
  y: number,
): Promise<unknown> {
  return send(
    `/api/workspaces/${encodeURIComponent(workspace)}/devices/${encodeURIComponent(deviceId)}`,
    'PATCH',
    { x, y },
  )
}

export function removeDevice(workspace: string, deviceId: string): Promise<unknown> {
  return send(
    `/api/workspaces/${encodeURIComponent(workspace)}/devices/${encodeURIComponent(deviceId)}`,
    'DELETE',
  )
}

export function attachScd(workspace: string, deviceId: string, ref: string): Promise<unknown> {
  return send(
    `/api/workspaces/${encodeURIComponent(workspace)}/devices/${encodeURIComponent(deviceId)}/scd`,
    'POST',
    { ref },
  )
}

export function detachScd(workspace: string, deviceId: string): Promise<unknown> {
  return send(
    `/api/workspaces/${encodeURIComponent(workspace)}/devices/${encodeURIComponent(deviceId)}/scd`,
    'DELETE',
  )
}
