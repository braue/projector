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

// How loudly a tier speaks. A drawn cable is painted by the worst thing
// riding it — one conflicting connection makes the whole run red, because
// that run is where a reader has to go looking.
const TIER_RANK: Record<LinkTier, number> = {
  conflict: 4,
  probable: 3,
  confirmed: 2,
  declared: 1,
  manual: 0,
}

export function worstTier(tiers: LinkTier[]): LinkTier {
  return tiers.reduce((worst, tier) => (TIER_RANK[tier] > TIER_RANK[worst] ? tier : worst), 'manual')
}
