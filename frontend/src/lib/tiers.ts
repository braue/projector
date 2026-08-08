import type { LinkTier } from '../types'

// One source for link-tier colors: canvas wires, popup badges, status-bar
// dots all read from here.
export const TIER_COLOR: Record<LinkTier, string> = {
  confirmed: '#1a9e5c',
  conflict: '#d63a3a',
  probable: '#d7930a',
  declared: '#a9adb8',
  manual: '#4b5160',
}

export const TIER_DASH: Partial<Record<LinkTier, string>> = {
  probable: '7 5',
  declared: '4 4',
}
