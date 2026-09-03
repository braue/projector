// Shapes served by the projector backend (see backend/services/projects.js).
// Only the fields the UI actually reads are typed — the API returns more; see
// the backend services for the full payloads.

/** One AcRTAC database project, as the database browser lists it. */
export interface RtacAvailableEntry {
  name: string
}

export interface RtacAvailableList {
  projects: RtacAvailableEntry[]
  /** Last database-list failure, or null when the list is healthy. */
  error: string | null
}

/** One in-flight (or failed) AcRTAC export, overlaid on the file tree. */
export interface RtacExportStatus {
  /** Tree path the export lands at ("Station A/GP-Naheola.rtac"). */
  path: string
  status: 'exporting' | 'error'
  at: number
  note: string
  /** The AcRTAC database this export pulls from — retry needs the REAL name
   *  (the tree path may be renamed or sanitized away from it). */
  database?: string
  /** The existing entry this export supersedes ("new version from AcRTAC"
   *  onto a differently-named entry) — retry must supersede the same one. */
  into?: string | null
  error?: string
}

export type ItemCategory =
  | 'connection'
  | 'tagList'
  | 'logic'
  | 'system'
  | 'hardware'
  | 'extension'
  | 'visual'
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

// --- the project tree -----------------------------------------------------------

/** Which settings-artifact family an entry belongs to (null = a plain file). */
export type ArtifactKindName = 'rtac' | 'rdb' | 'scd' | 'sw'

/** One archived version of a tree entry, newest first. */
export interface FileVersion {
  /** Real store path of the archived bytes ("dir/.versions/169…-name.rdb") —
   *  readable, openable, and inspectable like any entry. */
  path: string
  /** The name this version lived under when it was current — an entry
   *  renamed by a later arrival keeps its old identity here. */
  name: string
  /** Kinded by the version's own name, not the entry's present one. */
  kind: ArtifactKindName | null
  /** The AcRTAC database project this version mirrored, when known. */
  database: string | null
  size: number | null
  at: number | null
  note: string | null
}

export type FileNode =
  | { type: 'folder'; name: string; path: string; children: FileNode[] }
  | {
      type: 'file'
      name: string
      path: string
      kind: ArtifactKindName | null
      /** Null for artifact directories (RTAC exports). */
      size: number | null
      modifiedAt: string
      /** When this version landed, epoch ms (sidecar first, mtime fallback). */
      uploadedAt: number | null
      /** The version note — what this version changed. Null predates notes. */
      note: string | null
      /** The AcRTAC database project this entry mirrors, when known
       *  (recorded by database downloads and successful imports). */
      database: string | null
      /** The live bytes no longer match the recorded version — the working
       *  copy was edited in place (Excel, an external tool) and awaits
       *  "record as new version" or "discard". */
      edited: boolean
      versions: FileVersion[]
    }

export interface ArtifactProfile {
  name: string
  ref: string
  /** Device model/type badge: relay type for RDB, IED type for SCD. */
  deviceType: string | null
}

// --- tools (global utilities — see backend/routes/tools.js) -------------------

export type ToolJobStatus = 'running' | 'done' | 'error'

/** One slow tool operation, polled at /api/tools/jobs/:id until settled. */
export interface ToolJob {
  id: string
  label: string
  status: ToolJobStatus
  /** 0..1 when the work can estimate, null when it cannot. */
  progress: number | null
  log: string[]
  result: unknown
  error: string | null
}

/** One downloadable report file a tool run produced. */
export interface ToolReport {
  path: string
  label: string
  /** Set for supporting files (e.g. dwgen's AutoCAD bundle) that a tool may
   *  keep out of its headline outputs strip. */
  kind?: string
}

/** The HMI Tag Tester's analysis of one Diagram Builder project. */
export interface HmiReport {
  tool: string
  totalTags: number
  importedCount: number
  badTags: { tag: string; diagram: string }[]
  duplicateTags: { tag: string; count: number; sameScreen: boolean }[]
  /** Per-screen rollup, worst first — where to open Diagram Builder. */
  diagrams: { diagram: string; tags: number; bad: number; sameScreenDuplicates: number }[]
}

/** QuickSet Extract: the relay inventory over a configs run. */
export interface QuicksetInventory {
  tool: string
  run: string
  rows: { location: string; device: string; relayType: string; firmware: string }[]
  reports: ToolReport[]
}

/** QuickSet Extract: the pivoted settings extraction. */
export interface QuicksetExtract {
  tool: string
  run: string
  filesChecked: number
  hits: number
  columns: string[]
  rows: Record<string, string>[]
  reports: ToolReport[]
}

// --- DAC SIM Converter ----------------------------------------------------------

/** The generate job's result payload. */
export interface DacsimResult {
  run: string
  schemes: string[]
  dacProjects: string[]
  remoteProjects: number
  masterFolder: string
  files: number
  reports: ToolReport[]
}

// --- SWSET (switch settings editor) --------------------------------------------

export interface SwsetField {
  id: string
  label: string
  readOnly?: boolean
  /** Constrained choices (display labels); renders as a dropdown. */
  options?: string[]
}

export interface SwsetColumn {
  id: string
  label: string
  readOnly?: boolean
  /** Constant display value; never editable. */
  fixed?: string
  /** Constrained choices (display labels); renders as a dropdown. */
  options?: string[]
  /** Row-position-dependent choices (speed/duplex varies by port block). */
  optionsByRow?: { start: number; end?: number; options: string[] }[]
}

export type SwsetTable =
  | { kind: 'nameplate'; id: string; label: string; fields: SwsetField[]; values: Record<string, string | null> }
  | { kind: 'fields'; id: string; label: string; fields: SwsetField[]; values: Record<string, string | null> }
  | { kind: 'list'; id: string; label: string; columns: SwsetColumn[]; rows: Record<string, string | null>[]; canAddRows?: boolean }

export interface SwsetSection {
  id: string
  label: string
  tables: SwsetTable[]
}

export interface SwsetModel {
  tool: string
  run: string
  deviceType: string
  fid: string
  sections: SwsetSection[]
}

export interface SwsetGenerateResult {
  tool: string
  run: string
  applied: number
  skipped: string[]
  reports: ToolReport[]
}

/** RTAC Exporter: one project's export outcome. */
export interface RtacExportResult {
  project: string
  success: boolean
  output?: string
  error?: string
}

// --- DWGEN (drawing generator) -------------------------------------------------

export interface DwgenPosition {
  position: number
  label: string | null
  code: string
  description: string | null
  matched: boolean
  note?: string | null
}

export interface DwgenResult {
  tool: string
  run: string
  model: string
  product: string | null
  partNumber: string
  decoded: { positions: DwgenPosition[] }
  layers: string[]
  previews: string[]
  reports: ToolReport[]
  /** Drawings whose DWG is bundled in this run, keyed to their source PDF. */
  dwgs: { stem: string; pdf: string }[]
  /** Whether this machine has full AutoCAD for the "Open as DWG" pass. */
  autocad: boolean
  warnings: string[]
}

/** A row on the machine-global todo list (see api.ts listTodos). */
export interface Todo {
  id: string
  text: string
  done: boolean
}
