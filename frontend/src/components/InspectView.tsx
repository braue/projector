import { useCallback, useRef, useState } from 'react'

import { fetchArtifactItem, fetchArtifactProfiles, fetchArtifactTree } from '../api'
import { useFetch } from '../lib/useFetch'
import type { ArtifactKindName } from '../types'
import { AggregateView } from './AggregateView'
import { FileTree, TreePane } from './FileTree'
import { FindBar, useFindInPage } from './FindBar'
import { Preview } from './Preview'
import { SearchView } from './SearchView'
import { CollapsibleSection, SegmentedControl, Select } from './ui'

// Ctrl+F finds words in what the panes are SHOWING — the settings tree, the
// open item's settings and sheets. What is not on screen (a collapsed
// section, another sheet's tab, another object entirely) it cannot see, so
// the bar carries the escalation to Search, which asks the backend about the
// whole artifact with the term already typed.
//
// Inspect — the default face of a clicked settings artifact (live or an
// archived version; a version path is an artifact like any other). RTAC
// exports inspect whole; multi-profile artifacts (RDB relays, SCD IEDs) get
// a profile picker. Browse is the settings tree + preview; Aggregate (RTAC)
// pivots setting names across objects; Search finds a string anywhere in
// the artifact. A slim bar carries the artifact's name and those controls;
// the panes flex underneath.

type InspectSub = 'browse' | 'aggregate' | 'search'

export function InspectView({
  project,
  path,
  kind,
  title,
}: {
  project: string
  /** The artifact's tree path — the live entry or a `.versions/` path. */
  path: string
  kind: ArtifactKindName
  /** What to call it in pane headers (version label included). */
  title: string
}) {
  const [sub, setSub] = useState<InspectSub>('browse')
  const [profileRef, setProfileRef] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  // Escalated find terms arrive at Search through this, not through the bar's
  // own state: Search owns its query once it has it.
  const [searchSeed, setSearchSeed] = useState<string | null>(null)

  // The find root is the PANES, not the whole column: the bar floats inside
  // the column, and a bar that finds its own words is a bar that counts
  // itself.
  const panesRef = useRef<HTMLDivElement>(null)
  const getRoot = useCallback(() => panesRef.current, [])
  const find = useFindInPage({ getRoot })

  const isRtac = kind === 'rtac'
  const { data: profiles, error: profilesError } = useFetch(
    isRtac ? null : () => fetchArtifactProfiles(project, path),
    [project, path, isRtac],
  )

  // The addressed ref: the whole export for RTAC, else the picked profile
  // (first one until the user says otherwise).
  const ref = isRtac
    ? path
    : (profileRef && profiles?.some((profile) => profile.ref === profileRef)
        ? profileRef
        : profiles?.[0]?.ref ?? null)

  const { data: tree, error: treeError } = useFetch(
    ref && sub !== 'search' ? () => fetchArtifactTree(project, ref) : null,
    [project, ref, sub !== 'search'],
  )
  const { data: item, error: itemError } = useFetch(
    ref && selectedItem && sub === 'browse'
      ? () => fetchArtifactItem(project, ref, selectedItem)
      : null,
    [project, ref, selectedItem, sub],
    { keepStale: true },
  )

  const escalate = () => {
    setSearchSeed(find.term.trim())
    setSub('search')
    find.closeFind()
  }

  return (
    <div className="inspect-column">
      {find.open && (
        <FindBar
          inputRef={find.inputRef}
          term={find.term}
          onTerm={find.setTerm}
          count={find.count}
          onStep={find.step}
          onClose={find.closeFind}
          placeholder="Find in this view…"
          actions={
            sub !== 'search' && find.term.trim() ? (
              <button className="find-more" onClick={escalate} title="Search every object in the artifact">
                whole artifact
              </button>
            ) : null
          }
        />
      )}
      <div className="inspect-bar">
        <span className="inspect-title" title={path}>{title}</span>
        <SegmentedControl
          options={[
            { value: 'browse' as InspectSub, label: 'Browse' },
            ...(isRtac ? [{ value: 'aggregate' as InspectSub, label: 'Aggregate' }] : []),
            { value: 'search' as InspectSub, label: 'Search' },
          ]}
          value={sub}
          onChange={setSub}
        />
        {!isRtac && (profiles?.length ?? 0) > 1 && ref && (
          <Select
            value={ref}
            onChange={(value) => {
              setProfileRef(value)
              setSelectedItem(null)
            }}
            options={(profiles ?? []).map((profile) => ({
              value: profile.ref,
              label: profile.deviceType ? `${profile.name} · ${profile.deviceType}` : profile.name,
            }))}
          />
        )}
      </div>

      <div className="inspect-panes" ref={panesRef}>
        {sub === 'search' && ref ? (
          <SearchView
            key={`${project}:${ref}:${searchSeed ?? ''}`}
            project={project}
            refId={ref}
            initialQuery={searchSeed ?? undefined}
            onOpen={(itemPath) => {
              setSelectedItem(itemPath)
              setSub('browse')
            }}
          />
        ) : sub === 'aggregate' && isRtac ? (
          tree ? (
            <AggregateView key={`${project}:${path}`} project={project} name={path} tree={tree} />
          ) : (
            <main className="preview">
              <div className="pane-message">{treeError ?? 'Parsing…'}</div>
            </main>
          )
        ) : (
          <>
            {tree ? (
              <FileTree tree={tree} selected={selectedItem} onSelect={setSelectedItem} />
            ) : (
              <TreePane header={null}>
                <div className="pane-message">{treeError ?? profilesError ?? 'Parsing…'}</div>
              </TreePane>
            )}
            {item ? (
              <Preview item={item} />
            ) : (
              <main className="preview">
                {itemError && <div className="pane-message">{itemError}</div>}
                {/* Nothing picked yet: the project's own note is the thing
                    worth reading first — test procedures and expected
                    outcomes the engineer wrote into the export. */}
                {!itemError && tree?.description && (
                  <div className="preview-sections">
                    <CollapsibleSection title="Project Description">
                      <p className="section-note prose-note">{tree.description}</p>
                    </CollapsibleSection>
                  </div>
                )}
              </main>
            )}
          </>
        )}
      </div>
    </div>
  )
}
