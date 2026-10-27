// Light / dark: a `data-theme` attribute on <html> that index.css keys its
// dark token set off. Stored in machine settings like every other window pref.

import { useSyncExternalStore } from 'react'

import { saveSettings, setting } from './settings'

export type Theme = 'light' | 'dark'

const listeners = new Set<() => void>()

function current(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Called once at startup, after settings load and before the first render. */
export function applySavedTheme() {
  document.documentElement.dataset.theme = setting<Theme>('theme', 'light')
}

export function toggleTheme() {
  const next: Theme = current() === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  listeners.forEach((l) => l())
  saveSettings({ theme: next }).catch(() => {
    // A convenience value; the next toggle saves again.
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current)
}
