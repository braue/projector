/* eslint-disable react-hooks/exhaustive-deps -- generic hook: deps are supplied by the caller */
import { useEffect, useState } from 'react'

import { errorMessage } from './errors'

// One fetch-driven pane: run the loader when the deps change, keep only the
// latest response. Pass null as the loader when there is nothing to load —
// the data clears. `keepStale` leaves the previous data visible while the
// next response is in flight (detail panes) instead of flashing empty.
export function useFetch<T>(
  load: (() => Promise<T>) | null,
  deps: unknown[],
  { keepStale = false } = {},
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!keepStale || !load) setData(null)
    setError(null)
    if (!load) return
    let cancelled = false
    load()
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, deps)

  return { data, error }
}
