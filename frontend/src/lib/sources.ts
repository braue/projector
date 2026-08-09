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
export const SOURCE_MIME = 'application/purview-source'

/** Canonical key for placed-source lookups. */
export function sourceKey(source: DeviceSource): string {
  return `${source.type}:${source.ref}`
}
