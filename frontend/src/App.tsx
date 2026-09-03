import { Suspense, lazy, useCallback, useEffect, useState } from 'react'

import {
  createProject,
  deleteProject,
  fetchRtacStatus,
  listFiles,
  listProjects,
  openFileEntry,
  renameProject,
} from './api'
import { CompareView } from './components/CompareView'
import { InspectView } from './components/InspectView'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import {
  ProjectTree,
  findLeafFor,
  isTextFile,
  refLabel,
  type FileLeaf,
} from './components/ProjectTree'
import { TextFileView } from './components/TextFileView'
import { TodoList } from './components/TodoList'
// The atlas embeds the whole field-knowledge library — 82 documents inlined as
// raw text — so it is its own chunk, fetched the first time it is opened
// rather than parsed on every cold start.
const AtlasView = lazy(() =>
  import('./components/AtlasView').then((m) => ({ default: m.AtlasView })),
)
import { Button, TextInput } from './components/ui'
import { ToolsView } from './tools/ToolsView'
import { errorMessage } from './lib/errors'
import { FILES_CHANGED_EVENT } from './lib/filesChanged'
import { formatSize, formatStamp, formatWhen } from './lib/format'
import type { FileNode, RtacExportStatus } from './types'

const EXPORT_POLL_MS = 1200
const PROJECT_KEY = 'projector-project'

export default function App() {
  // Reference material and global utilities sit beside the project, hold the
  // top-right corner, and latch once opened so an open terminal session or a
  // half-read page survives a detour back into the project.
  const [atlasOpen, setAtlasOpen] = useState(false)
  const [atlasEverOpened, setAtlasEverOpened] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsEverOpened, setToolsEverOpened] = useState(false)
  // The current project scopes everything below. null projects = still
  // loading the list; null project + loaded list = nothing exists yet.
  const [project, setProject] = useState<string | null>(null)
  const [projects, setProjects] = useState<string[] | null>(null)
  // THE tree — the one sidebar everything lives in.
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [exports, setExports] = useState<RtacExportStatus[]>([])
  // Selection: the path being worked on (live entry or archived version), a
  // SECOND path picked with ctrl+click, and — only once asked for from the
  // context menu — the compare pair being viewed.
  const [selected, setSelected] = useState<string | null>(null)
  const [secondary, setSecondary] = useState<string | null>(null)
  const [comparePair, setComparePair] = useState<{ original: string; updated: string } | null>(null)

  const loadTree = useCallback(async () => {
    if (!project) return
    try {
      setTree(await listFiles(project))
      setTreeError(null)
    } catch (err) {
      setTreeError(`Cannot reach the backend: ${errorMessage(err)}`)
    }
  }, [project])

  const loadExports = useCallback(async () => {
    if (!project) return
    try {
      setExports(await fetchRtacStatus(project))
    } catch {
      // The status overlay is best-effort; the tree itself already surfaces
      // backend failures.
    }
  }, [project])

  const refreshProjects = useCallback(async () => {
    try {
      const names = await listProjects()
      setProjects(names)
      return names
    } catch {
      return null
    }
  }, [])

  // Startup: restore the last-used project if it still exists, otherwise the
  // first one; none at all leaves `project` null and gates on naming one.
  useEffect(() => {
    refreshProjects().then((names) => {
      if (!names) return
      const remembered = localStorage.getItem(PROJECT_KEY)
      setProject(remembered && names.includes(remembered) ? remembered : names[0] ?? null)
    })
  }, [refreshProjects])

  useEffect(() => {
    if (project) localStorage.setItem(PROJECT_KEY, project)
  }, [project])

  // Switching projects swaps the tree and clears per-project state.
  useEffect(() => {
    setTree(null)
    setTreeError(null)
    setExports([])
    setSelected(null)
    setSecondary(null)
    setComparePair(null)
    if (!project) return
    loadTree()
    loadExports()
  }, [project, loadTree, loadExports])

  // Coming back to the app — from Excel, the file manager, anywhere an
  // entry's working copy may have been edited in place — is the moment to
  // re-check the tree, so "edited" flags appear without a manual action.
  // Tools that change project files (the DAC SIM Converter placing its
  // generated entries) announce it with the same effect.
  useEffect(() => {
    if (!project) return
    const onFocus = () => loadTree()
    window.addEventListener('focus', onFocus)
    window.addEventListener(FILES_CHANGED_EVENT, onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(FILES_CHANGED_EVENT, onFocus)
    }
  }, [project, loadTree])

  // Poll while any AcRTAC export is in flight so spinners resolve on their
  // own; a download that finishes (drops out of the status list) means the
  // tree gained an entry.
  const exporting = exports.some((entry) => entry.status === 'exporting')
  useEffect(() => {
    if (!exporting || !project) return
    const timer = window.setTimeout(async () => {
      const before = exports.filter((entry) => entry.status === 'exporting').length
      await loadExports()
      // A completed export changed the tree even if others still run.
      setExports((current) => {
        const after = current.filter((entry) => entry.status === 'exporting').length
        if (after < before) loadTree()
        return current
      })
    }, EXPORT_POLL_MS)
    return () => window.clearTimeout(timer)
  }, [exporting, exports, project, loadExports, loadTree])

  const handleCreateProject = useCallback(
    async (name: string) => {
      await createProject(name)
      await refreshProjects()
      setProject(name)
    },
    [refreshProjects],
  )

  const handleRenameProject = useCallback(
    async (name: string, nextName: string) => {
      const renamed = await renameProject(name, nextName)
      await refreshProjects()
      setProject((current) => (current === name ? renamed.name : current))
    },
    [refreshProjects],
  )

  const handleDeleteProject = useCallback(
    async (name: string) => {
      if (!window.confirm(`Delete project "${name}" and everything in it? This cannot be undone.`)) {
        return
      }
      try {
        await deleteProject(name)
      } catch (err) {
        setTreeError(errorMessage(err))
        return
      }
      const names = (await refreshProjects()) ?? []
      setProject((current) => (current === name ? names[0] ?? null : current))
    },
    [refreshProjects],
  )

  // A plain click is a fresh single selection — any second pick and any
  // open comparison follow the click away.
  const handleSelect = useCallback((path: string | null) => {
    setSelected(path)
    setSecondary(null)
    setComparePair(null)
  }, [])

  // Ctrl/cmd-click: pick (or unpick) the SECOND selection. Comparing itself
  // is asked for from the context menu once two rows are held.
  const handleToggleSecondary = useCallback((path: string) => {
    setComparePair(null)
    setSecondary((current) => {
      if (current === path) return null
      return path
    })
  }, [])

  const handleComparePair = useCallback((original: string, updated: string) => {
    setComparePair({ original, updated })
  }, [])

  // Still loading the project list: just the shell, no flash of onboarding.
  if (projects === null) {
    return <header className="topbar" />
  }

  if (project === null) {
    return <FirstProject onCreate={handleCreateProject} />
  }

  // What the main pane shows for the current selection.
  const selectedLeaf: FileLeaf | null =
    tree && selected !== null ? findLeafFor(tree, selected) : null

  return (
    <>
      <header className="topbar">
        {/* Top-left: the project — the only control on that side. It goes
            away while a takeover pane is up, since nothing on screen is
            scoped to a project then. */}
        {!atlasOpen && !toolsOpen && (
          <ProjectSwitcher
            current={project}
            projects={projects}
            onSelect={setProject}
            onCreate={handleCreateProject}
            onRename={handleRenameProject}
            onDelete={handleDeleteProject}
          />
        )}
        <span className="topbar-info" />
        {/* Top-right: the machine-global panes, holding the corner so their
            toggles never move. */}
        <TodoList />
        <button
          className={toolsOpen ? 'topbar-button topbar-toggle on' : 'topbar-button topbar-toggle'}
          onClick={() => {
            setToolsOpen((open) => !open)
            setToolsEverOpened(true)
            setAtlasOpen(false)
          }}
          title={toolsOpen ? 'Back to the project' : 'Open the tools'}
        >
          <span className="topbar-toggle-mark">⚒</span>
          <span>Tools</span>
        </button>
        <button
          className={atlasOpen ? 'topbar-button topbar-toggle on' : 'topbar-button topbar-toggle'}
          onClick={() => {
            setAtlasOpen((open) => !open)
            setAtlasEverOpened(true)
            setToolsOpen(false)
          }}
          title={atlasOpen ? 'Back to the project' : 'Open the atlas reference'}
        >
          <span className="topbar-toggle-mark">◆</span>
          <span>Atlas</span>
        </button>
      </header>

      <div className="app">
        {!atlasOpen && !toolsOpen && (
          <>
            <ProjectTree
              project={project}
              tree={tree}
              treeError={treeError}
              exports={exports}
              selected={selected}
              secondary={secondary}
              onSelect={handleSelect}
              onToggleSecondary={handleToggleSecondary}
              onComparePair={handleComparePair}
              onReload={loadTree}
              onExportsChanged={loadExports}
            />

            {comparePair ? (
              <CompareView
                project={project}
                original={{ ref: comparePair.original, label: refLabel(tree, comparePair.original) }}
                updated={{ ref: comparePair.updated, label: refLabel(tree, comparePair.updated) }}
                onSwap={() => setComparePair({ original: comparePair.updated, updated: comparePair.original })}
                onClear={() => setComparePair(null)}
              />
            ) : selected && selectedLeaf?.kind ? (
              <InspectView
                key={`${project}:${selected}`}
                project={project}
                path={selected}
                kind={selectedLeaf.kind}
                title={refLabel(tree, selected)}
              />
            ) : selected && selectedLeaf && isTextFile(selectedLeaf.name) ? (
              <TextFileView
                key={`${project}:${selected}`}
                project={project}
                path={selected}
                name={refLabel(tree, selected)}
                readOnly={selected !== selectedLeaf.path}
              />
            ) : selected && selectedLeaf ? (
              <FileInfo project={project} path={selected} leaf={selectedLeaf} />
            ) : (
              <main className="preview">
                {tree === null && treeError && (
                  <div className="pane-message">{treeError}</div>
                )}
              </main>
            )}
          </>
        )}

        {/* Same latch as the atlas: an open terminal session or half-filled
            tool form survives a detour back into the project. */}
        {toolsEverOpened && (
          <div className="tools-pane" hidden={!toolsOpen}>
            <ToolsView project={project} />
          </div>
        )}

        {/* Mounted from the first open onwards — never before, so the library
            is not in the startup path, and never unmounted after. */}
        {atlasEverOpened && (
          <div className="atlas-pane" hidden={!atlasOpen}>
            <Suspense fallback={null}>
              <AtlasView active={atlasOpen} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  )
}

/** Details for a plain (non-artifact, non-text) file — or an archived
 *  version of one: size, times, note, and the OS-default-app open. */
function FileInfo({
  project,
  path,
  leaf,
}: {
  project: string
  path: string
  leaf: FileLeaf
}) {
  const [error, setError] = useState<string | null>(null)
  const isVersion = path !== leaf.path
  const version = isVersion ? leaf.versions.find((v) => v.path === path) : null
  const at = isVersion ? version?.at ?? null : leaf.uploadedAt
  const note = isVersion ? version?.note ?? null : leaf.note
  const size = isVersion ? version?.size ?? null : leaf.size

  return (
    <main className="preview">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{leaf.name}</h2>
          {isVersion && version && (
            <span className="note-count">
              v{leaf.versions.length - leaf.versions.indexOf(version)}
            </span>
          )}
        </div>
        <div className="preview-subtitle">
          <span className="mono">{path}</span>
        </div>
      </header>
      <div className="files-detail">
        {size !== null && <div>{formatSize(size)}</div>}
        {at !== null && <div title={formatWhen(at)}>Added {formatStamp(at)}</div>}
        {note && <div className="file-note">“{note}”</div>}
        <Button
          variant="primary"
          onClick={() => openFileEntry(project, path).catch((err) => setError(errorMessage(err)))}
        >
          Open
        </Button>
        {error && <div className="list-error-text">{error}</div>}
      </div>
    </main>
  )
}

// The first-run gate: nothing exists until the user names a project.
function FirstProject({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <>
      <header className="topbar" />
      <div className="app onboard">
        <div className="modal-card onboard-card">
          <div className="modal-head">
            <span className="t">Name your first project</span>
          </div>
          <div className="modal-sub">
            A project is one folder tree — settings artifacts, documents, and
            notes side by side, everything scoped to one job.
          </div>
          <div className="onboard-form">
            <TextInput
              autoFocus
              value={name}
              placeholder="e.g. Substation 12 upgrade"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
            />
            <Button variant="primary" disabled={!name.trim() || busy} onClick={create}>
              Create project
            </Button>
          </div>
          {error && <div className="modal-error onboard-error">{error}</div>}
        </div>
      </div>
    </>
  )
}
