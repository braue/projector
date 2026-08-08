import type {
  AggregateResult,
  CompareItem,
  CompareTree,
  DeviceSource,
  ProjectItem,
  ProjectList,
  ProjectTree,
  WorkspaceGraph,
} from './types'

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export function listProjects(): Promise<ProjectList> {
  return get('/api/projects')
}

// Retry the database list after a failure.
export async function refreshProjects(): Promise<ProjectList> {
  const res = await fetch('/api/projects/refresh', { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export async function startExport(name: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}/export`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
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

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    throw new Error(parsed?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export function aggregateSettings(
  name: string,
  terms: string[],
  files: string[],
): Promise<AggregateResult> {
  return send(`/api/projects/${encodeURIComponent(name)}/aggregate`, 'POST', { terms, files })
}

// --- workspaces / canvas ------------------------------------------------------

export async function listWorkspaces(): Promise<string[]> {
  const body = await get<{ workspaces: string[] }>('/api/workspaces')
  return body.workspaces
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
