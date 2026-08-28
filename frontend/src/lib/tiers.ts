import type { GraphLink, LinkTier } from '../types'

// A wire's tone is its tier, except that an acknowledged conflict speaks
// quietly: the settings still disagree (the tier stays 'conflict'), but the
// engineer has recorded why that is acceptable, so the canvas stops shouting.
export type WireTone = LinkTier | 'waived'

export const linkTone = (link: Pick<GraphLink, 'tier' | 'waived'>): WireTone =>
  link.waived ? 'waived' : link.tier

/** The user-facing word for a tone (badges); tiers read as themselves. */
export const TONE_LABEL: Partial<Record<WireTone, string>> = {
  waived: 'acknowledged',
}

// One source for link-tone colors: canvas wires, popup badges, status-bar
// dots all read from here. The values are token references, not literals, so
// a tone edited in index.css moves the wires with it — these are consumed as
// inline `stroke` and `color`, where var() resolves normally.
export const TIER_COLOR: Record<WireTone, string> = {
  confirmed: 'var(--ok)',
  conflict: 'var(--bad)',
  probable: 'var(--warn)',
  declared: 'var(--ghost)',
  manual: 'var(--ink-soft)',
  waived: 'var(--ink-soft)',
}

export const TIER_DASH: Partial<Record<WireTone, string>> = {
  probable: '7 5',
  declared: '4 4',
  waived: '2 4',
}

// How loudly a tone speaks. A drawn cable is painted by the worst thing
// riding it — one conflicting connection makes the whole run red, because
// that run is where a reader has to go looking. An acknowledged conflict
// ranks below everything that still asks for attention: it must not redden
// (or amber) a run whose open questions are elsewhere.
const TIER_RANK: Record<WireTone, number> = {
  conflict: 5,
  probable: 4,
  confirmed: 3,
  declared: 2,
  waived: 1,
  manual: 0,
}

export function worstTier(tones: WireTone[]): WireTone {
  return tones.reduce((worst, tone) => (TIER_RANK[tone] > TIER_RANK[worst] ? tone : worst), 'manual')
}
