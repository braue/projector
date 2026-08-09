# purview — design document

*Working title. A settings-truth communications canvas for substation devices.*

## What it is

A web app with a blank canvas. You load settings artifacts — RTAC projects
(via the AcRTAC exportxml pipeline), RDB relay profiles (upload), or SEL
Architect / SCD files (upload) — and drag the devices they describe onto the
canvas. The app parses each artifact, normalizes what it says about that
device's communications, and automatically draws the links between devices:
protocol, IP addresses, ports, serial parameters, addressing. Compare
behaviors from rtac-explorer carry over per source type.

## Core concept: artifacts are testimony, links are inference

Every artifact describes ONE device's view of its own communications
(an SCD describes many devices at once — see below):

- RTAC project: "I dial these IP:ports with these protocols (clients),
  listen on these ports (servers), own these serial ports at these bauds."
- RDB profile: "I am an SEL-751A; Port 5 is Ethernet at 192.168.1.50, DNP
  listens on 20000 with DNP address 4; Port 3 is serial SEL at 19200."
- SCD: IEDs, access points, subnetworks with IP assignments, GOOSE/SV
  publish-subscribe, report control blocks.

A link on the canvas is never stored data — it is the matcher
cross-referencing two testimonies. RTAC dials 192.168.1.50:20000 DNP; a
dropped RDB owns that IP and listens on that port with DNP → wire drawn,
protocol labeled, endpoint chips at both ends.

### Link tiers (the visual language)

| Tier      | Meaning                                              | Rendering |
|-----------|------------------------------------------------------|-----------|
| confirmed | both ends' settings agree (IP + port + protocol)     | solid |
| conflict  | both ends claim the link but disagree (port, protocol, DNP address, baud) | red + warning badge |
| probable  | partial match (IP only; name-similarity for serial)  | amber |
| declared  | one side declares it; far end not loaded             | dashed, to a ghost node |
| manual    | user-drawn (serial pairs, mostly)                    | solid, user-marked |

**Ghost nodes:** dropping one RTAC project immediately spawns grey dashed
placeholder boxes for every far end it declares. Dropping the matching RDB
later snaps the ghost into a real device (IP match). The canvas is useful
from the first artifact.

**Conflicts are the commissioning feature:** the app is a misconfiguration
detector. RTAC dials :20000, relay listens on :20001 → red. RTAC expects
DNP address 4, relay set to 3 → red with the two values shown.

**Serial links** cannot auto-match (no shared address space): user drags
RTAC `Com_03` chip → relay `Port 3` chip (manual link, persisted). The
matcher still validates the pair — baud / data bits / protocol agreement —
and turns it red on mismatch. Name-similarity between the RTAC connection
name and the RDB profile name yields "probable" suggestions.

## UI layout

```
┌────────────────────────────────────────────────────────────┐
│ topbar: brand · [Canvas | Inspect | Compare] · workspace   │
├──────────┬─────────────────────────────────────┬───────────┤
│ Sources  │            CANVAS                   │ Inspector │
│ tabs:    │                                     │ (drawer,  │
│ RTAC     │   [RTAC_Main]────DNP───▶[SEL-751A]  │  opens on │
│ RDB      │       │ :20000    192.168.1.50:20000│ selection)│
│ SCD      │       └──serial··▶[ghost: Com_05]   │           │
│          │                                     │           │
│ profile  │   subnet region (from SCD)          │           │
│ list,    │   ┌ ─ ─ ─ ─ ─ ─ ─ ┐                 │           │
│ drag +   │                                     │           │
│ upload   │                                     │           │
├──────────┴─────────────────────────────────────┴───────────┤
│ status: 12 links · 9 confirmed · 2 declared · 1 CONFLICT   │
└────────────────────────────────────────────────────────────┘
```

- **Sources sidebar, 3 tabs.**
  - RTAC: the exact rtac-explorer flow (grey → double-click download →
    spinner → ready), then drag onto canvas. List-error panel + retry as
    built.
  - RDB / SCD: drop zone + upload button. One file can yield several
    profiles (an RDB holds multiple relays; an SCD many IEDs) — the list
    shows profiles, not files.
- **Canvas:** React Flow. Free drag, positions persisted, auto-layout
  button. Device cards show name, model, small interface/port chips. Edges
  carry protocol label + endpoint chip at each end ("192.168.1.50:20000",
  "Port 5"). SCD subnetworks draw as dashed regions; GOOSE renders as
  publisher → subscriber fan-out.
- **Inspector drawer:** link click → the evidence: both ends' relevant raw
  settings side-by-side, conflicting values highlighted. Device click →
  interfaces + full endpoint list; declared-but-unplaced far ends can be
  ghost-spawned from here.
- **Inspect mode:** entered EITHER by clicking a device box on the canvas
  (jumps to Inspect with that device selected) or via the Inspect tab +
  sidebar selection. Read-only settings browsing for ONE loaded artifact —
  full object tree + the rtac-explorer preview (pinned searchable settings,
  one tab per settings page). A Browse/Aggregate toggle inside the pane
  switches to the aggregate-settings table (setting names × checked object
  scope, within this file) carried over from rtac-explorer.
- **Compare mode:** across two files of the same kind — two RTAC projects,
  two RDB profiles, two SCDs. The rtac-explorer UX (tinted union tree +
  structured diff); RDB compares sections/settings per profile; SCD
  compares IEDs/datasets/control blocks. Later: canvas snapshot compare
  (wires tinted by change).
- **Status bar:** link counts by tier; conflict count is the number that
  matters.

## Architecture

Same proven shape as rtac-explorer (Node/Express backend, React/Vite
frontend, ui.tsx primitive seam preserved for the internal design-system
swap), plus a normalization layer that is the heart of the app:

```
backend/
  lib/parsers/rtac/      carried over (kind registry, loss-tolerant)
  lib/parsers/rdb/       ported from Volture (CFB/QuickSet; [INFO] block,
                         settings sections, Cfg.txt name translations)
  lib/parsers/scd/       SCL/XML parser (fast-xml-parser), sectioned like the
                         Architect workbook extractor: Network, per-dataset
                         FCDA→sAddr source resolution, GOOSE TX (wire + SEL
                         privates), GOOSE RX (formatted ExtRefs), Reports
  lib/parsers/sw/        SEL managed-switch settings XML (SEL-2730M):
                         nameplate, physical ports, VLAN plan, management
                         interfaces — switches place on the canvas as network
                         fabric and take manually drawn port connections.
                         GOOSE links are VLAN-checked through the drawn
                         fabric: SCL VLAN-IDs (3 hex digits) decode to the
                         VLAN the publication rides, and a switch port or
                         trunk that drops it turns the link into a conflict
  lib/comm/model.js      CommModel — the shared normalized shape
  lib/comm/extract/      one extractor per source type → CommModel
  lib/comm/linker.js     pure matcher: (profiles, manualLinks) → links +
                         network review — GOOSE VLAN paths walked across
                         drawn access ports and trunk chains (BFS), IP route
                         sanity (off-subnet with no gateway), same-subnet L2
                         reachability, and workspace diagnostics (duplicate
                         IPs, GOOSE APPID/MAC collisions; same-identity
                         placements never collide with themselves)
  lib/uploadService.js   the upload-source lifecycle, once: versioned
                         background re-parse, upload/list/profile refs, and
                         the tree→item compare adapter — a service supplies
                         parse/profilesOf/findProfile + its inspect sections
  lib/inspect.js         the inspect-item shapes (section nodes, table
                         pages, item defaults) all services build from
  services/sources.js    RTAC pipeline (as built) + RDB/SCD/SW uploads
  services/workspaces.js named canvases: placements, manual links, notes
                         (JSON per workspace under data/)
  routes/                sources, workspaces, links, compare
frontend/
  components/ui.tsx      primitive seam, carried over
  canvas/                React Flow graph, nodes, edges, inspector
  sources/               source-tab sidebar (RTAC / RDB / SCD / SW)
  compare/               per-source compare views
```

### CommModel

Parsers never talk to the canvas. Every source reduces to:

```js
DeviceProfile {
  id, source: { type: 'rtac' | 'rdb' | 'scd', ref },
  name, manufacturer, model,
  interfaces: [ { kind: 'ethernet' | 'serial', name, ip?, mask?, mac? } ],
  endpoints:  [ {
    role: 'client' | 'server' | 'peer' | 'publisher' | 'subscriber',
    protocol,                       // DNP3, Modbus, SEL, IEC61850, GOOSE...
    transport: 'tcp' | 'udp' | 'serial' | 'goose',
    localInterface?, localPort?,
    remoteAddress?, remotePort?,
    serial?: { port, baud, dataBits, parity, stopBits },
    addressing: { dnpLocal?, dnpRemote?, modbusUnit?, appId?, ... },
    raw                              // untouched source settings — the
  } ]                                // inspector's evidence
}
```

Adding a new source type (another Architect format, a future artifact) is
one new extractor; matcher and canvas are untouched. Same registry
philosophy as the RTAC parser's kinds.js.

### The linker

A pure, deterministic function over CommModels + manual links → links with
tiers and conflict details. No I/O, no app state: unit-tested with fixture
profiles. Matching passes:

1. TCP/UDP: client (remoteAddress:remotePort, protocol) vs server
   (interface ip, localPort, protocol). Full agreement → confirmed.
   Address-only → probable. Disagreement on port/protocol/addressing when
   the address pins the pair → conflict (with both values).
2. Addressing check on matched pairs (DNP address pair, Modbus unit) —
   mismatch downgrades to conflict.
3. Serial: manual links validated (baud/framing/protocol); unmatched serial
   endpoints get name-similarity suggestions (probable).
4. GOOSE/SV (SCD): publisher control block → subscriber inputs, rendered
   as fan-out.
5. Anything declared but unmatched → ghost node (grouped by artifact).

## SCD notes (pending examples)

SCL is a standardized XML schema (IEC 61850-6): Communication section →
SubNetwork → ConnectedAP (IED access point + IP), IED sections → LDevice /
LN, GSEControl / SampledValueControl / ReportControl, DataSet, Inputs/ExtRefs
for subscriptions. One SCD spawns many device profiles plus subnet regions.
Parser follows the RTAC parser's philosophy: structural layer + registry of
element kinds, loss-tolerant, unknown elements carried generically. Real
fixtures needed before building — user will supply examples.

## Build order

1. **Skeleton + RTAC + canvas with ghosts.** Port rtac-explorer's backend
   service/parsers and sidebar; add React Flow canvas, workspace
   persistence, extractor for RTAC CommModel, linker tiers
   confirmed/declared/ghost from a single source type. Useful immediately.
2. **RDB.** Port Volture's rdb parser; RDB extractor (port info → ethernet
   interface + server endpoints; serial ports; protocol addressing);
   uploads; two-sided matching + conflicts + ghost snapping.
3. **SCD.** With example files: SCL parser, IED spawning, subnet regions,
   GOOSE fan-out.
4. **Compare integration + reporting.** Per-source compare views; conflict
   report export (CSV); canvas PNG export; canvas snapshot diff.

## Decisions taken (revisit freely)

- New repo (rtac-explorer stays as-is); parser code copied over, not
  shared via a package — two apps, no coupling.
- Multiple named workspaces.
- Static settings analysis only — no live polling/telemetry (unlike
  Volture). Deployable anywhere, no runtime deps.
- Backend loopback + Vite proxy, same as rtac-explorer.
- AcRTAC access identical to rtac-explorer (selacrtac bridge, no mock).

## Open questions for the user

- ~~Name: gridlink? commscape? something else?~~ Settled: **Purview** (2026-08-08).
- RDB examples: Volture's parser handles QuickSet .rdb — confirm the files
  you'll upload are QuickSet exports (not something else).
- SCD: waiting on example files (SEL Architect exports — .scd? .cid/.icd
  too?).
- Should conflict rules be configurable (e.g. ignore baud mismatches), or
  fixed to start?
```
