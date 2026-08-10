import { useState } from 'react'

import { useDebounced } from './useDebounced'

/** Query state for the live search panes: raw input + debounced needle. */
export function useSearchQuery() {
  const [query, setQuery] = useState('')
  const needle = useDebounced(query, 200).trim().toLowerCase()
  return { query, setQuery, needle }
}
