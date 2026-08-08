import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchItem, fetchTree, listProjects, refreshProjects, startExport } from './api'
import { AggregateView } from './components/AggregateView'
import { CanvasView } from './components/CanvasView'
import { CompareView } from './components/CompareView'
import { FileTree } from './components/FileTree'
import { Preview } from './components/Preview'
import { SourcesSidebar } from './components/SourcesSidebar'
import { SegmentedControl } from './components/ui'
import type { ProjectEntry, ProjectItem, ProjectTree, WorkspaceGraph } from './types'

const POLL_MS = 1200
const WORKSPACE = 'Default' // named workspaces get a switcher later

type Mode = 'canvas' | 'inspect' | 'compare'
type InspectSub = 'browse' | 'aggregate'

const MODES: { value: Mode; label: string }[] = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'inspect', label: 'Inspect' },
  { value: 'compare', label: 'Compare' },
]

export default function App() {
  const [mode, setMode] = useState<Mode>('canvas')
  const [inspectSub, setInspectSub] = useState<InspectSub>('browse')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [tree, setTree] = useState<ProjectTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  const [item, setItem] = useState<ProjectItem | null>(null)
  const [itemError, setItemError] = useState<string | null>(null)
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const pollTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects()
      setProjects(list.projects)
      setListError(list.error)
      return list.projects
    } catch (err) {
      setListError(`Cannot reach the backend: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }, [])

  const retryList = useCallback(async () => {
    try {
      const list = await refreshProjects()
      setProjects(list.projects)
      setListError(list.error)
    } catch {
      await refresh()
    }
  }, [refresh])

  // Poll while any export is in flight so spinners resolve on their own.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const list = await refresh()
      if (cancelled) return
      if (list.some((p) => p.status === 'exporting')) {
        pollTimer.current = window.setTimeout(tick, POLL_MS)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
    }
  }, [refresh])

  const handleExport = useCallback(
    async (name: string) => {
      try {
        await startExport(name)
      } catch (err) {
        setListError(
          `Could not start the export of ${name}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      setSelectedProject((current) => (current === name ? null : current))
      const list = await refresh()
      if (list.some((p) => p.status === 'exporting') && pollTimer.current === null) {
        pollTimer.current = window.setTimeout(async function tick() {
          const next = await refresh()
          pollTimer.current = next.some((p) => p.status === 'exporting')
            ? window.setTimeout(tick, POLL_MS)
            : null
        }, POLL_MS)
      }
    },
    [refresh],
  )

  // Selecting a project (sidebar click, or canvas node click via onInspect).
  const handleSelectProject = useCallback((name: string) => {
    setSelectedProject(name)
    setSelectedItem(null)
    setItem(null)
    setItemError(null)
  }, [])

  const inspectFromCanvas = useCallback(
    (ref: string) => {
      handleSelectProject(ref)
      setMode('inspect')
      setInspectSub('browse')
    },
    [handleSelectProject],
  )

  useEffect(() => {
    if (!selectedProject) {
      setTree(null)
      return
    }
    let cancelled = false
    setTree(null)
    setTreeError(null)
    fetchTree(selectedProject)
      .then((t) => !cancelled && setTree(t))
      .catch((err) => !cancelled && setTreeError(err.message))
    return () => {
      cancelled = true
    }
  }, [selectedProject])

  useEffect(() => {
    if (!selectedProject || !selectedItem) {
      setItem(null)
      return
    }
    let cancelled = false
    setItemError(null)
    fetchItem(selectedProject, selectedItem)
      .then((i) => !cancelled && setItem(i))
      .catch((err) => !cancelled && setItemError(err.message))
    return () => {
      cancelled = true
    }
  }, [selectedProject, selectedItem])

  const placedRefs = useMemo(
    () =>
      new Set(
        (graph?.devices ?? [])
          .filter((device) => device.source.type === 'rtac')
          .map((device) => device.source.ref),
      ),
    [graph],
  )

  const topbarInfo =
    mode === 'canvas' && graph
      ? `${graph.summary.confirmed + graph.summary.probable + graph.summary.declared + graph.summary.manual + graph.summary.conflicts} connections · ${graph.summary.conflicts} conflict${graph.summary.conflicts === 1 ? '' : 's'}`
      : mode === 'inspect' && selectedProject
        ? `${selectedProject} · read-only`
        : ''

  return (
    <>
      <header className="topbar">
        <span className="brand">Gridlink</span>
        <SegmentedControl options={MODES} value={mode} onChange={setMode} />
        {mode === 'inspect' && selectedProject && (
          <SegmentedControl
            options={[
              { value: 'browse' as InspectSub, label: 'Browse' },
              { value: 'aggregate' as InspectSub, label: 'Aggregate' },
            ]}
            value={inspectSub}
            onChange={setInspectSub}
          />
        )}
        <span className="topbar-info">{topbarInfo}</span>
      </header>

      <div className="app">
        {mode !== 'compare' && (
          <SourcesSidebar
            projects={projects}
            listError={listError}
            onRetryList={retryList}
            selected={mode === 'inspect' ? selectedProject : null}
            onSelect={(name) => {
              handleSelectProject(name)
              if (mode !== 'inspect') return
              setInspectSub('browse')
            }}
            onExport={handleExport}
            placedRefs={placedRefs}
            footer={
              mode === 'canvas'
                ? 'Double-click to download · drag to canvas'
                : 'Click to inspect'
            }
          />
        )}

        {mode === 'canvas' && (
          <div className="canvas-column">
            <CanvasView workspace={WORKSPACE} onInspect={inspectFromCanvas} onGraph={setGraph} />
            <div className="status-bar">
              {graph ? (
                <>
                  <span><b>{graph.summary.devices}</b> devices</span>
                  <span className="tierdot"><span className="d" style={{ background: '#1a9e5c' }} /><b>{graph.summary.confirmed}</b> confirmed</span>
                  <span className="tierdot"><span className="d" style={{ background: '#d7930a' }} /><b>{graph.summary.probable}</b> suggested</span>
                  <span className="tierdot"><span className="d" style={{ background: '#a9adb8' }} /><b>{graph.summary.declared}</b> declared</span>
                  <span className={graph.summary.conflicts ? 'conflict' : undefined}>
                    {graph.summary.conflicts} conflict{graph.summary.conflicts === 1 ? '' : 's'}
                  </span>
                </>
              ) : (
                <span>Drag a downloaded project onto the canvas to begin.</span>
              )}
            </div>
          </div>
        )}

        {mode === 'inspect' &&
          (selectedProject && tree && inspectSub === 'aggregate' ? (
            <AggregateView key={selectedProject} project={selectedProject} tree={tree} />
          ) : (
            <>
              {selectedProject && tree && (
                <FileTree tree={tree} selected={selectedItem} onSelect={setSelectedItem} />
              )}
              {selectedProject && !tree && (
                <aside className="file-tree">
                  <div className="pane-message">{treeError ?? 'Loading project…'}</div>
                </aside>
              )}
              {item ? (
                <Preview item={item} />
              ) : (
                <main className="preview">
                  <div className="pane-message">
                    {itemError ??
                      (selectedProject
                        ? 'Select an item in the project tree to view its settings.'
                        : 'Pick a downloaded project from the sidebar — or click a device on the canvas.')}
                  </div>
                </main>
              )}
            </>
          ))}

        {mode === 'compare' && <CompareView projects={projects} />}
      </div>
    </>
  )
}
