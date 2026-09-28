// The busy/error pair every button that calls the backend needs: `run(fn)`
// marks busy, clears the last error, and turns a throw into `error` text.
// Returns whether `fn` succeeded, for callers that close or move on after.

import { useState } from 'react'

import { errorMessage } from './errors'

export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  return { run, busy, error, setError }
}
