import { REF_SEPARATOR } from '../types'
import type { DeviceSource, SourceType } from '../types'

// The shared source-type registry: tab order, drag payload MIME, and the
// canonical "is this source on the canvas" key format.

export const SOURCE_TABS: { key: SourceType; label: string }[] = [
  { key: 'rtac', label: 'RTAC' },
  { key: 'rdb', label: 'RDB' },
  { key: 'scd', label: 'SCD' },
  { key: 'sw', label: 'SW' },
]

/** Drag payload: JSON DeviceSource under this MIME. */
export const SOURCE_MIME = 'application/projector-source'

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
