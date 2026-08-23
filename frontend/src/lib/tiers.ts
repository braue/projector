import type { LinkTier } from '../types'

// One source for link-tier colors: canvas wires, popup badges, status-bar
// dots all read from here. The values are token references, not literals, so
// a tone edited in index.css moves the wires with it — these are consumed as
// inline `stroke` and `color`, where var() resolves normally.
export const TIER_COLOR: Record<LinkTier, string> = {
  confirmed: 'var(--ok)',
  conflict: 'var(--bad)',
  probable: 'var(--warn)',
  declared: 'var(--ghost)',
  manual: 'var(--ink-soft)',
}

export const TIER_DASH: Partial<Record<LinkTier, string>> = {
  probable: '7 5',
  declared: '4 4',
}
