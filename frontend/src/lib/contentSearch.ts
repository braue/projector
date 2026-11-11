import { useEffect, useState } from 'react'

import { fetchIndexStatus, searchProjectContent } from '../api'
import type { ContentResult, IndexStatus } from '../types'
import { onEvent } from './events'
import { useDebounced } from './useDebounced'

/** Shortest term worth looking inside files for. */
const MIN_TERM = 2

/**
 * The tree filter's content half: the files whose TEXT holds the term, with
 * located snippets — and the index's progress, so a search run while files
 * are still being read is re-run as they land.
 */
export function useContentSearch(project: string | null, filter: string) {
  const term = useDebounced(filter.trim(), 250)
  const [hits, setHits] = useState<Map<string, ContentResult>>(new Map())
  const [status, setStatus] = useState<IndexStatus | null>(null)
  // Bumped when the index has read more, so the same term is asked again.
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    setStatus(null)
    if (!project) return
    let live = true
    fetchIndexStatus(project).then((s) => live && setStatus(s)).catch(() => {})
    const off = onEvent('index', (data: IndexStatus & { project: string }) => {
      if (data.project !== project) return
      setStatus(data)
      setEpoch((n) => n + 1)
    })
    return () => {
      live = false
      off()
    }
  }, [project])

  useEffect(() => {
    if (!project || term.length < MIN_TERM) {
      setHits(new Map())
      return
    }
    let live = true
    searchProjectContent(project, term)
      .then((result) => {
        if (!live) return
        setHits(new Map(result.results.map((r) => [r.path, r])))
        setStatus(result.status)
      })
      .catch(() => live && setHits(new Map()))
    return () => {
      live = false
    }
  }, [project, term, epoch])

  return { hits, status, term }
}
