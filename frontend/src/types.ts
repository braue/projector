// Shapes served by the projector backend (see backend/services/projects.js).
// Only the fields the UI actually reads are typed — the API returns more; see
// the backend services for the full payloads.

export type ProjectStatus = 'exporting' | 'ready' | 'error'

/** One RTAC export in the current project. */
export interface ProjectEntry {
  name: string
  status: ProjectStatus
  error?: string
}

export interface ProjectList {
  projects: ProjectEntry[]
}

/** One AcRTAC database project, as the database browser lists it. */
export interface RtacAvailableEntry {
  name: string
  /** Already exported into the current projector project. */
  inProject: boolean
}

export interface RtacAvailableList {
  projects: RtacAvailableEntry[]
  /** Last database-list failure, or null when the list is healthy. */
  error: string | null
}

export type ItemCategory =
  | 'connection'
  | 'tagList'
  | 'logic'
  | 'system'
  | 'hardware'
  | 'extension'
  | 'meta'
  | 'other'

export type FileStatus = 'added' | 'removed' | 'edited' | 'unchanged'

export interface TreeItemNode {
  type: 'item'
  name: string
  path: string
  kindLabel: string
  category: ItemCategory
  protocol?: string | null
  pointCount?: number
  error?: string
  status?: FileStatus
}

export interface TreeFolderNode {
  type: 'folder'
  name: string
  path: string
  children: TreeNode[]
  /** Compare only: its contents' status, so a closed folder still speaks. */
  status?: FileStatus
}

export type TreeNode = TreeFolderNode | TreeItemNode

export interface ProjectSummary {
  files: number
  // RTAC exports only — absent for RDB profiles.
  connections?: number
  totalPoints?: number
}

export interface ProjectTree {
  name: string
  schema: string | null
  /** Display name of the device, e.g. "SEL-3555" or "SEL-735". */
  deviceLabel: string | null
  summary: ProjectSummary
  tree: TreeNode[]
}

export interface SettingPage {
  name: string
  columns: string[]
  rows: Record<string, string>[]
}

/** One normalized point; the preview renders its page's sheet from `raw`. */
export interface Point {
  page: string
  raw: Record<string, string>
}

// One export file, fully parsed. Kind-specific fields are optional — the
// preview renders whatever is present.
export interface ProjectItem {
  file: string
  category: ItemCategory
  kindLabel: string
  name: string | null
  settings: Record<string, string>
  points: Point[]
  pages: SettingPage[]
  // RDB panel drawings: the item is a generated image, served at `url`.
  image?: { url: string; view?: string } | null
  // connection
  protocol?: string | null
  role?: string | null
  connectionType?: string | null
  manufacturer?: string | null
  model?: string | null
  endpoint?: string | null
  sharedMap?: { file: string; name: string | null; points: Point[] } | null
  // tag list
  tagListType?: string | null
  // logic
  pouKind?: string | null
  code?: { interface?: string | null; implementation?: string | null } | null
  hasArchivedContent?: boolean
  // hardware
  nodes?: {
    name: string | null
    slotCount: string | null
    startingSlot: string | null
    slots: Record<string, string>[]
  }[]
  // extension
  definitionName?: string | null
  definitionVersion?: string | null
  version?: string | null
  description?: string | null
  files?: { name: string | null; functions: { name: string | null; type: string | null }[] }[]
  // meta
  layout?: LayoutItem[]
}

export interface LayoutItem {
  name: string | null
  isFolder: boolean
  items: LayoutItem[]
}

// --- compare -----------------------------------------------------------------

export interface CompareTree {
  original: { name: string }
  updated: { name: string }
  summary: { added: number; removed: number; edited: number; unchanged: number }
  tree: TreeNode[]
}

export interface SettingDiff {
  key: string
  original: string | null
  updated: string | null
  status: 'added' | 'removed' | 'changed'
}

export interface PointFieldDiff {
  column: string
  original: string | null
  updated: string | null
}

export interface ItemDiff {
  settings: SettingDiff[]
  points: {
    added: { page: string; tag: string | null }[]
    removed: { page: string; tag: string | null }[]
    changed: { page: string; tag: string | null; fields: PointFieldDiff[] }[]
  }
  pages: {
    name: string
    /** 'reordered' = same rows, different order — no row-level detail. */
    status: 'added' | 'removed' | 'changed' | 'reordered'
    rows: number
    /** Row-level detail, present on changed pages: whole row OBJECTS plus
     * the columns those rows use, so the UI renders real tables. */
    columns?: string[]
    /** ONE merged change list, pre-sorted by row position (removed →
     * changed → added on ties) — the backend owns ordering and the split
     * of edits into displayed `fields` vs `hidden` (noise-column) edits.
     * `index` is the 0-based row position in the entry's own side. */
    changes?: {
      kind: 'added' | 'removed' | 'changed'
      index: number
      /** added/removed entries */
      row?: Record<string, string>
      /** changed entries */
      label?: string
      original?: Record<string, string>
      updated?: Record<string, string>
      fields?: string[]
      hidden?: { column: string; original: string | null; updated: string | null }[]
    }[]
  }[]
  code: {
    interface: { original: string | null; updated: string | null } | null
    implementation: { original: string | null; updated: string | null } | null
  } | null
  /** Graphical (CFC/LD) logic body — only its fingerprint is modeled, so the
   * diff can say that it changed, never what. */
  graphicalLogic: 'added' | 'removed' | 'changed' | null
  otherFields: string[]
}

export interface CompareItem {
  file: string
  status: FileStatus
  original: ProjectItem | null
  updated: ProjectItem | null
  diff: ItemDiff
}

// --- aggregate ---------------------------------------------------------------

export interface AggregateMatch {
  name: string
  value: string
}

export interface AggregateRow {
  file: string
  name: string
  kindLabel: string
  category: ItemCategory
  protocol: string | null
  values: Record<string, AggregateMatch[]>
}

export interface AggregateResult {
  terms: string[]
  scoped: boolean
  rows: AggregateRow[]
}

// --- notes --------------------------------------------------------------------

export interface Note {
  id: string
  name: string
  /** One free-form text blob; list markers ("[ ]", "-", "1.") are plain text. */
  text: string
}

// --- search -------------------------------------------------------------------

export interface SearchMatch {
  /** Where inside the object: setting key, "page · row · column", "line N". */
  location: string
  text: string
}

export interface SearchHit {
  path: string
  name: string
  kindLabel: string
  protocol: string | null
  matches: SearchMatch[]
  /** More matches existed in this object than the payload carries. */
  truncated: boolean
}

export interface SearchResults {
  query: string
  /** Display label of the searched source. */
  label: string
  results: SearchHit[]
  totalMatches: number
  /** More matching objects existed than the payload carries. */
  truncated: boolean
}

// --- the everywhere search ----------------------------------------------------
//
// One string across EVERY project: each project's settings sources plus its
// notes, grouped by project. Hits are pointers — opening one jumps to that
// project's Inspect (or note), where the full listing lives.

export interface EverywhereSourceHit {
  type: SourceType
  ref: string
  /** Display label of the source ("feeders.rdb · FEEDER_1"). */
  label: string
  results: SearchHit[]
  totalMatches: number
  truncated: boolean
}

export interface EverywhereNoteHit {
  id: string
  name: string
  matches: SearchMatch[]
  totalMatches: number
  truncated: boolean
}

export interface EverywhereProjectHits {
  name: string
  sources: EverywhereSourceHit[]
  notes: EverywhereNoteHit[]
}

export interface EverywhereResults {
  query: string
  projects: EverywhereProjectHits[]
  /** Sources that could not be searched — reported, never fatal. */
  errors: { project: string; source: string | null; error: string }[]
}

// --- project files ------------------------------------------------------------

export type FileNode =
  | { type: 'folder'; name: string; path: string; children: FileNode[] }
  | { type: 'file'; name: string; path: string; size: number; modifiedAt: string }

// --- canvas / workspaces ------------------------------------------------------

export type SourceType = 'rtac' | 'rdb' | 'scd' | 'sw'

export interface DeviceSource {
  type: SourceType
  ref: string
}

/** An rdb ref is "<fileId>::<profileName>" (see backend/services/rdb.js). */
export const REF_SEPARATOR = '::'

/** The upload-backed source types (RTAC projects come from the database). */
export type UploadSourceType = 'rdb' | 'scd' | 'sw'

export interface UploadProfileEntry {
  name: string
  ref: string
  /** Device model/type badge: relay type for RDB, IED type for SCD. */
  deviceType: string | null
}

export interface UploadedFile {
  id: string
  fileName: string
  profiles: UploadProfileEntry[]
}

export type LinkTier = 'confirmed' | 'conflict' | 'probable' | 'declared' | 'manual'

// Mirrors graphDevice() in backend/lib/comm/model.js — the projection is the
// contract; change the two together.
export interface GraphDevice {
  id: string
  x: number
  y: number
  source: DeviceSource
  name: string
  model: string | null
  endpointCount?: number
  error?: string
  /** Network fabric ('switch') vs an end device (absent). */
  kind?: string
  /** Physical port inventory — the connect dialog's choices (switches). */
  ports?: { id: string; name: string | null; enabled: boolean }[]
  /** Serial lines the connect dialog can pair by hand. */
  serialEndpoints?: { id: string; name: string; detail: string | null }[]
  /** SCD profile augmenting this device, when one is attached. */
  scd?: { ref: string; error?: string; warning?: string } | null
}

/** A workspace-wide settings finding (duplicate IP, GOOSE wire collision). */
export interface NetworkDiagnostic {
  severity: 'error' | 'warning'
  text: string
}

export interface GraphGhost {
  id: string
  label: string
  sublabel: string
  /** Human-readable port/protocol statements, shown in the hub popup. */
  lines: string[]
}

/**
 * One question the linker asked of a link, and the answer it got.
 *
 *   pass     asked and both ends agree
 *   fail     asked and they disagree — this is what makes a link a conflict
 *   warn     worth knowing, not proof of a fault
 *   unknown  could not be asked: one side states nothing. Never guessed.
 *
 * Every link carries the whole list, passes included: the point is to show
 * what was verified, not only what went wrong.
 */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown'

export interface LinkCheck {
  label: string
  status: CheckStatus
  detail: string
}

export interface GraphLink {
  id: string
  /** Set on user-drawn links — its presence enables "Remove connection". */
  manualId?: string
  /**
   * An acknowledged conflict: the engineer recorded why this disagreement is
   * acceptable. The tier stays 'conflict' — the settings still disagree —
   * but the canvas paints it quiet and the to-do count skips it. The server
   * drops the mark the moment the disagreeing values change.
   */
  waived?: { id: string; reason: string; at: string }
  sourceDeviceId: string
  targetDeviceId?: string
  targetGhostId?: string
  /**
   * The drawn cable run this link travels, as manual link ids in order.
   * Present only on inferred links, and only when the user has drawn a path
   * between the two ends: the canvas then rides those segments instead of
   * cutting a chord across the switches between them.
   */
  path?: string[]
  tier: LinkTier
  summary: string
  a: { label: string; lines: string[] }
  b: { label: string; lines: string[] }
  checks: LinkCheck[]
}

export interface WorkspaceGraph {
  name: string
  devices: GraphDevice[]
  ghosts: GraphGhost[]
  links: GraphLink[]
  diagnostics: NetworkDiagnostic[]
  /** The linker's tier tallies: open conflicts, and acknowledged ones. */
  summary: { conflicts: number; waived: number }
}
