// Shapes served by the rtac-explorer backend (see backend/services/projects.js).

export type ProjectStatus = 'available' | 'exporting' | 'ready' | 'error'

export interface ProjectEntry {
  name: string
  status: ProjectStatus
  error?: string
}

export interface ProjectList {
  projects: ProjectEntry[]
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
  kind: string
  kindLabel: string
  category: ItemCategory
  protocol?: string | null
  connectionType?: string | null
  pointCount?: number
  error?: string
  status?: FileStatus
}

export interface TreeFolderNode {
  type: 'folder'
  name: string
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeFolderNode | TreeItemNode

export interface ProjectSummary {
  files: number
  connections: number
  clients: number
  servers: number
  peers: number
  totalPoints: number
  protocols: string[]
}

export interface ProjectTree {
  name: string
  schema: string | null
  deviceMOT: string | null
  summary: ProjectSummary
  errors: { file: string; error: string }[]
  tree: TreeNode[]
}

export interface SettingPage {
  name: string
  columns: string[]
  rows: Record<string, string>[]
  addItems?: { start: string; quantity: string }
}

export interface Point {
  page: string
  tagName: string | null
  tagType: string | null
  alias: string | null
  enabled: boolean | null
  addressColumn: string | null
  address: string | null
  comment: string | null
  raw: Record<string, string>
}

// One export file, fully parsed. Kind-specific fields are optional — the
// preview renders whatever is present.
export interface ProjectItem {
  id: string
  file: string
  kind: string
  category: ItemCategory
  kindLabel: string
  name: string | null
  schema: string | null
  deviceMOT: string | null
  settings: Record<string, string>
  points: Point[]
  pointCount: number
  pages: SettingPage[]
  hasControllerPou: boolean
  // connection
  protocol?: string | null
  protocolFamily?: string | null
  role?: string | null
  connectionType?: string | null
  manufacturer?: string | null
  model?: string | null
  endpoint?: string | null
  sharedMapRef?: string | null
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
  pages: { name: string; status: 'added' | 'removed' | 'changed'; rows: number }[]
  code: { original: string | null; updated: string | null } | null
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

// --- canvas / workspaces ------------------------------------------------------

export type SourceType = 'rtac' | 'rdb' | 'scd'

export interface DeviceSource {
  type: SourceType
  ref: string
}

export interface RdbProfileEntry {
  name: string
  ref: string
  relayType: string | null
}

export interface RdbFile {
  id: string
  fileName: string
  profiles: RdbProfileEntry[]
}

export type LinkTier = 'confirmed' | 'conflict' | 'probable' | 'declared' | 'manual'

export interface GraphDevice {
  id: string
  x: number
  y: number
  source: DeviceSource
  name: string
  model: string | null
  endpointCount?: number
  error?: string
}

export interface GraphGhost {
  id: string
  label: string
  sublabel: string
  lines: string[]
}

export interface LinkWarning {
  kind: 'error' | 'warning'
  text: string
}

export interface GraphLink {
  id: string
  sourceDeviceId: string
  targetDeviceId?: string
  targetGhostId?: string
  tier: LinkTier
  protocol: string | null
  transport: string
  summary: string
  a: { label: string; lines: string[] }
  b: { label: string; lines: string[] }
  warnings: LinkWarning[]
}

export interface WorkspaceGraph {
  name: string
  devices: GraphDevice[]
  ghosts: GraphGhost[]
  links: GraphLink[]
  summary: {
    devices: number
    confirmed: number
    conflicts: number
    probable: number
    declared: number
    manual: number
  }
}
