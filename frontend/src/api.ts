import type {
  AggregateResult,
  CompareItem,
  CompareTree,
  DeviceSource,
  ProjectItem,
  ProjectList,
  ProjectTree,
  RdbFile,
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

export function fetchCompareTree(original: string, updated: string): Promise<CompareTree> {
  return get(
    `/api/compare/tree?original=${encodeURIComponent(original)}&updated=${encodeURIComponent(updated)}`,
  )
}

export function fetchCompareItem(
  original: string,
  updated: string,
  file: string,
): Promise<CompareItem> {
  return get(
    `/api/compare/item?original=${encodeURIComponent(original)}&updated=${encodeURIComponent(updated)}&file=${encodeURIComponent(file)}`,
  )
}

export function aggregateSettings(
  name: string,
  terms: string[],
  files: string[],
): Promise<AggregateResult> {
  return send(`/api/projects/${encodeURIComponent(name)}/aggregate`, 'POST', { terms, files })
}

// --- rdb ----------------------------------------------------------------------

export async function listRdbFiles(): Promise<RdbFile[]> {
  const body = await get<{ files: RdbFile[] }>('/api/rdb')
  return body.files
}

export function uploadRdb(file: File): Promise<RdbFile> {
  const form = new FormData()
  form.append('file', file)
  return send('/api/rdb', 'POST', form)
}

export function deleteRdbFile(id: string): Promise<unknown> {
  return send(`/api/rdb/${encodeURIComponent(id)}`, 'DELETE')
}

// Inspect works for any source type — same shapes, per-type endpoints.
export function fetchSourceTree(source: DeviceSource): Promise<ProjectTree> {
  if (source.type === 'rdb') return get(`/api/rdb/tree?ref=${encodeURIComponent(source.ref)}`)
  return fetchTree(source.ref)
}

export function fetchSourceItem(source: DeviceSource, file: string): Promise<ProjectItem> {
  if (source.type === 'rdb') {
    return get(`/api/rdb/item?ref=${encodeURIComponent(source.ref)}&file=${encodeURIComponent(file)}`)
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
