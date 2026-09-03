// The Tools pane — a beside-the-modes takeover like the atlas: a rail of
// global utilities on the left, the selected tool's interface on the right.
// Opened tools latch-mount and stay mounted while hidden, so a terminal
// session or a half-filled form survives switching between tools.

import { useCallback, useState } from 'react'

import { useSidebarWidth } from '../lib/usePaneWidth'
import { TOOLS } from './registry'

export function ToolsView({ project }: { project: string }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [everOpened, setEverOpened] = useState<Set<string>>(new Set())
  const { width, startResize } = useSidebarWidth()

  const open = useCallback((id: string) => {
    setSelected(id)
    setEverOpened((current) => (current.has(id) ? current : new Set(current).add(id)))
  }, [])

  return (
    <>
      <aside className="sources" style={{ width }}>
        <div className="tools-rail-head">Tools</div>
        <ul className="source-list">
          {TOOLS.map((tool) => (
            <li key={tool.id}>
              <button
                className={
                  tool.id === selected
                    ? 'project-entry status-ready selected'
                    : 'project-entry status-ready'
                }
                onClick={() => open(tool.id)}
              >
                <span className="project-name">{tool.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-resize" onMouseDown={startResize} />
      </aside>
      <main className="preview">
        {selected === null && (
          <div className="pane-message">Pick a tool from the list.</div>
        )}
        {TOOLS.filter((tool) => everOpened.has(tool.id)).map((tool) => (
          <div key={tool.id} className="tool-host" hidden={tool.id !== selected}>
            <tool.component project={project} active={tool.id === selected} />
          </div>
        ))}
      </main>
    </>
  )
}
