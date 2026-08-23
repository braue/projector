// Content model. Documents live as plain files under content/<category>/.
// .md files: optional frontmatter (title / summary / tags / order), rendered natively.
// .html files: standalone pages (the animated field guides), embedded whole.
//   <meta name="atlas-order">  reading position within the category (ascending)
//   <meta name="atlas-tags">   comma-separated search tags
// Adding a doc = dropping a file in a category folder; Vite picks it up.

export type DocKind = 'md' | 'html'

export interface Doc {
  id: string
  category: string
  /** optional subfolder within the category (e.g. "dnp3") */
  group: string | null
  kind: DocKind
  title: string
  summary: string
  tags: string[]
  /** reading position within the category; lower comes first */
  order: number
  raw: string
  /** plain text, original case — used for search snippets */
  plain: string
  /** plain text, lowercased — used for search matching */
  text: string
}

export const GROUP_LABELS: Record<string, string> = {
  dnp3: 'DNP3',
  modbus: 'Modbus',
  dac: 'DAC / FLISR',
  blueframe: 'Blueframe',
}

/** groups render after ungrouped docs, in this order */
export const GROUP_ORDER: Record<string, number> = {
  dnp3: 10,
  modbus: 20,
  dac: 10,
  blueframe: 10,
}

export function groupLabel(id: string): string {
  return GROUP_LABELS[id] ?? titleFromFile(id)
}

export interface Category {
  id: string
  label: string
  hint: string
}

/** Sidebar order = the order a newcomer should read them in. */
export const CATEGORIES: Category[] = [
  { id: 'start-here', label: 'Start Here', hint: 'the job, the map, the vocabulary' },
  { id: 'fundamentals', label: 'Power System Fundamentals', hint: 'AC, faults, grounding, CTs, drawings, DC' },
  { id: 'protection', label: 'Protection', hint: 'elements, schemes, coordination, by equipment' },
  { id: 'relays-devices', label: 'Relays & Devices', hint: 'SELogic, metering, records, settings' },
  { id: 'comms', label: 'Communications', hint: 'serial, Ethernet, fiber, time, security' },
  { id: 'data-protocols', label: 'Data Protocols', hint: 'DNP3, Modbus, 61850, Mirrored Bits' },
  { id: 'rtac-automation', label: 'RTAC & Automation', hint: 'tags, logic, HMI, SCADA integration' },
  { id: 'distribution-equipment', label: 'Distribution Equipment', hint: 'regulators, capacitors, fault indicators, DER' },
  { id: 'distribution-automation', label: 'Distribution Automation', hint: 'FLISR: locating, isolating, restoring' },
  { id: 'commissioning', label: 'Commissioning & Field Work', hint: 'working safely on live plant' },
  { id: 'reference', label: 'Reference', hint: 'acronyms, device numbers, products, formulas' },
]

/** Curated reading paths shown on the home screen. Values are doc ids. */
export interface Path {
  label: string
  blurb: string
  docs: string[]
}

export const PATHS: Path[] = [
  {
    label: 'New to substations',
    blurb: 'Twelve pages that take you from "what is a substation" to reading a relay event.',
    docs: [
      'start-here/the-job.html',
      'start-here/field-kit.html',
      'fundamentals/ac-power-basics.html',
      'fundamentals/one-line-diagrams.html',
      'fundamentals/substation-anatomy.html',
      'fundamentals/faults-and-fault-current.html',
      'fundamentals/ct-pt-fundamentals.html',
      'fundamentals/dc-systems.html',
      'protection/protection-elements.html',
      'relays-devices/relay-anatomy.html',
      'relays-devices/ser-soe.html',
      'commissioning/safety-practices.html',
    ],
  },
  {
    label: 'Integration engineer',
    blurb: 'Getting a device on the network, into the RTAC, and up to SCADA.',
    docs: [
      'data-protocols/protocol-chooser.html',
      'comms/serial-comms.html',
      'comms/ethernet-ip.html',
      'comms/time-sync.html',
      'data-protocols/dnp3/fundamentals.html',
      'rtac-automation/rtac-platform.html',
      'rtac-automation/rtac-tags.html',
      'rtac-automation/scada-integration.html',
    ],
  },
  {
    label: 'Protection engineer',
    blurb: 'From measuring quantities to schemes, coordination, and settings.',
    docs: [
      'fundamentals/symmetrical-components.html',
      'fundamentals/faults-and-fault-current.html',
      'protection/protection-elements.html',
      'protection/coordination-tcc.html',
      'protection/distance-21.html',
      'protection/line-differential-87l.html',
      'protection/differential-87.html',
      'protection/breaker-failure.html',
      'relays-devices/settings-management.html',
    ],
  },
  {
    label: 'Out on the feeder',
    blurb: 'The equipment past the substation fence and how it is controlled.',
    docs: [
      'distribution-equipment/voltage-regulation.html',
      'distribution-equipment/capacitor-control.html',
      'distribution-equipment/fault-indicators.html',
      'distribution-equipment/der-interconnection.html',
    ],
  },
  {
    label: 'Distribution automation',
    blurb: 'Locating a fault, isolating it, and restoring what is left.',
    docs: [
      'protection/reclosing.html',
      'distribution-equipment/fault-indicators.html',
      'distribution-automation/dac/how-it-decides.html',
      'distribution-automation/dac/operating-it.html',
      'distribution-automation/dac/optional-features.html',
      'rtac-automation/blueframe/dms.html',
    ],
  },
]

/** Task-shaped entry points ("I need to …") for the home screen. */
export interface Task {
  q: string
  doc: string
}

export const TASKS: Task[] = [
  { q: 'A SCADA control does not operate the breaker', doc: 'data-protocols/dnp3/controls.html' },
  { q: 'Build a points list / IO map for a new device', doc: 'rtac-automation/scada-integration.html' },
  { q: 'Pick a protocol for a third-party device', doc: 'data-protocols/protocol-chooser.html' },
  { q: 'Set overcurrent pickups that coordinate', doc: 'protection/coordination-tcc.html' },
  { q: 'Wire and prove a CT circuit safely', doc: 'commissioning/safety-practices.html' },
  { q: 'Understand what a drawing is telling me', doc: 'fundamentals/one-line-diagrams.html' },
  { q: 'Write RTAC logic for a scheme', doc: 'rtac-automation/rtac-logic.html' },
  { q: 'Upgrade relay firmware without losing settings', doc: 'relays-devices/firmware-upgrades.html' },
  { q: 'Automate event and settings collection', doc: 'rtac-automation/blueframe/dma.html' },
  { q: 'Set a regulator or switch a capacitor bank', doc: 'distribution-equipment/voltage-regulation.html' },
  { q: 'Look up an ANSI number or acronym', doc: 'reference/ansi-device-numbers.md' },
]

const mdModules = import.meta.glob('../../../../atlas/content/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const htmlModules = import.meta.glob('../../../../atlas/content/**/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function parsePath(path: string): { category: string; group: string | null; file: string } | null {
  const m = path.match(/atlas\/content\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/)
  if (!m) return null
  return { category: m[1], group: m[2] ?? null, file: m[3] }
}

interface Frontmatter {
  title?: string
  summary?: string
  tags?: string
  order?: string
  [k: string]: string | undefined
}

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { fm: {}, body: raw }
  const fm: Frontmatter = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim()
  }
  return { fm, body: raw.slice(m[0].length) }
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripMd(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|[\]()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleFromFile(file: string): string {
  return file
    .replace(/\.(md|html)$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function metaContent(raw: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, 'i')
  const tag = raw.match(re)
  if (!tag) return null
  const c = tag[0].match(/content=["']([^"']*)["']/i)
  return c ? c[1] : null
}

function splitTags(s: string | null | undefined): string[] {
  return s ? s.split(',').map((t) => t.trim()).filter(Boolean) : []
}

function buildDocs(): Doc[] {
  const docs: Doc[] = []

  for (const [path, raw] of Object.entries(mdModules)) {
    const p = parsePath(path)
    if (!p) continue
    const { fm, body } = parseFrontmatter(raw)
    const h1 = body.match(/^#\s+(.+)$/m)
    const plain = stripMd(body)
    docs.push({
      id: `${p.category}/${p.group ? p.group + '/' : ''}${p.file}`,
      category: p.category,
      group: p.group,
      kind: 'md',
      title: fm.title || (h1 ? h1[1].trim() : titleFromFile(p.file)),
      summary: fm.summary || '',
      tags: splitTags(fm.tags),
      order: fm.order ? Number(fm.order) : 500,
      raw: body,
      plain,
      text: plain.toLowerCase(),
    })
  }

  for (const [path, raw] of Object.entries(htmlModules)) {
    const p = parsePath(path)
    if (!p) continue
    const titleTag = raw.match(/<title>([\s\S]*?)<\/title>/i)
    const mastheadP = raw.match(/class="masthead"[\s\S]*?<p>([\s\S]*?)<\/p>/i)
    const order = metaContent(raw, 'atlas-order')
    const plain = stripHtml(raw)
    docs.push({
      id: `${p.category}/${p.group ? p.group + '/' : ''}${p.file}`,
      category: p.category,
      group: p.group,
      kind: 'html',
      title: titleTag ? stripHtml(titleTag[1]) : titleFromFile(p.file),
      summary: mastheadP ? stripHtml(mastheadP[1]) : '',
      tags: splitTags(metaContent(raw, 'atlas-tags')),
      order: order ? Number(order) : 500,
      raw,
      plain,
      text: plain.toLowerCase(),
    })
  }

  docs.sort((a, b) => a.title.localeCompare(b.title))
  return docs
}

export const DOCS: Doc[] = buildDocs()

const BY_ID = new Map(DOCS.map((d) => [d.id, d]))

export function docById(id: string): Doc | null {
  return BY_ID.get(id) ?? null
}

function groupRank(g: string | null): number {
  if (!g) return -1
  return GROUP_ORDER[g] ?? 100
}

/**
 * Docs in reading order: ungrouped first, then groups, each by explicit order.
 * Bucketed once at module load — the category rail asks for this on every
 * render, once per category.
 */
const BY_CATEGORY = new Map<string, Doc[]>()
for (const d of DOCS) {
  const bucket = BY_CATEGORY.get(d.category)
  if (bucket) bucket.push(d)
  else BY_CATEGORY.set(d.category, [d])
}
for (const bucket of BY_CATEGORY.values()) {
  bucket.sort((a, b) => {
    const g = groupRank(a.group) - groupRank(b.group)
    if (g !== 0) return g
    if (a.order !== b.order) return a.order - b.order
    return a.title.localeCompare(b.title)
  })
}

export function docsInCategory(catId: string): Doc[] {
  return BY_CATEGORY.get(catId) ?? []
}

/** Every doc, in full sidebar order — used for prev/next. */
export function docsInReadingOrder(): Doc[] {
  const out: Doc[] = []
  for (const c of [...CATEGORIES, ...extraCategories()]) out.push(...docsInCategory(c.id))
  return out
}

export function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? titleFromFile(id)
}

export function breadcrumb(d: Doc): string {
  const base = categoryLabel(d.category)
  return d.group ? `${base} · ${groupLabel(d.group)}` : base
}

/** categories that exist in content but aren't in CATEGORIES — shown so nothing silently disappears */
export function extraCategories(): Category[] {
  const known = new Set(CATEGORIES.map((c) => c.id))
  const extras = [...new Set(DOCS.map((d) => d.category))].filter((c) => !known.has(c))
  return extras.map((id) => ({ id, label: titleFromFile(id), hint: '' }))
}
