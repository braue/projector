import { REF_SEPARATOR } from '../types'
import type { DeviceSource, ProjectEntry, SourceType } from '../types'

// The shared source-type registry: tab order, drag payload MIME, and the
// canonical "is this source on the canvas" key format.

export const SOURCE_TABS: { value: SourceType; label: string }[] = [
  { value: 'rtac', label: 'RTAC' },
  { value: 'rdb', label: 'RDB' },
  { value: 'scd', label: 'SCD' },
  { value: 'sw', label: 'SW' },
]

/** Drag payload: JSON DeviceSource under this MIME. */
export const SOURCE_MIME = 'application/projector-source'

/**
 * The two halves of an RTAC export, kept behind functions so no caller has to
 * remember which field is which. Both are plain strings, so `ref:
 * entry.displayName` would compile and quietly point a placement at a name
 * two copies share — these make that impossible to write by accident.
 */
export function rtacSource(entry: ProjectEntry): DeviceSource {
  return { type: 'rtac', ref: entry.name }
}

/** What to call an export on screen. */
export function rtacLabel(entry: ProjectEntry): string {
  return entry.displayName
}

/** Canonical key for placed-source lookups. */
export function sourceKey(source: DeviceSource): string {
  return `${source.type}:${source.ref}`
}

/** Swap the file-id half of an upload ref, preserving the profile — how a
 * selection follows an upload rename. (Mirror of backend/lib/refs.js.) */
export function replaceRefFile(ref: string, fromId: string, toId: string): string {
  const prefix = `${fromId}${REF_SEPARATOR}`
  return ref.startsWith(prefix) ? `${toId}${REF_SEPARATOR}${ref.slice(prefix.length)}` : ref
}
