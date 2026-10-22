// Machine settings in the window: read once before the first render
// (main.tsx), then read synchronously anywhere. They are stored server-side
// (backend services/settings.js) rather than in localStorage because the
// packaged app's origin changes every launch, taking localStorage with it.

import { fetchSettings, updateSettings } from '../api'

let cache: Record<string, unknown> = {}

// Debounced writes, coalesced across keys: a pane drag is one save, not one
// per mousemove.
const SAVE_SOON_MS = 500
let pending: Record<string, unknown> = {}
let timer: ReturnType<typeof setTimeout> | null = null

/** Called once at startup. An unreachable backend leaves the defaults —
 *  the window still opens, and saves only ever merge, never wipe. */
export async function loadSettings(): Promise<void> {
  try {
    cache = await fetchSettings()
  } catch {
    cache = {}
  }
}

export function setting<T>(key: string, fallback: T): T {
  return key in cache ? (cache[key] as T) : fallback
}

/** Save now; rejects with the backend's error for callers that show it. */
export async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  Object.assign(cache, patch)
  await updateSettings(patch)
}

/** Save shortly — for values that change continuously. */
export function saveSettingSoon(key: string, value: unknown) {
  cache[key] = value
  pending[key] = value
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, SAVE_SOON_MS)
}

function flush(keepalive = false) {
  if (timer) clearTimeout(timer)
  timer = null
  if (!Object.keys(pending).length) return
  const patch = pending
  pending = {}
  updateSettings(patch, { keepalive }).catch(() => {
    // A convenience value; the next change saves again.
  })
}

// A drag that ends right before the window closes still lands.
window.addEventListener('pagehide', () => flush(true))
