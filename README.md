# Purview

A settings-truth communications canvas for substation devices. Load settings
artifacts — RTAC projects (via the AcRTAC database), RDB relay profiles, SEL
Architect / SCD files — drag the devices they describe onto a canvas, and the
app cross-references what each artifact says about its own communications to
draw the links between devices: protocol, addresses, ports, and whether both
ends actually agree.

See `DESIGN.md` for the full design (CommModel, linker tiers, build phases)
and `mockups.html` for the reviewed UI mockups.

## Modes

- **Canvas** — boxes and colored wires. Drag a source from the sidebar onto
  the canvas; the linker infers every link it can defend. Wire colors:
  green = confirmed, red = conflict, amber = suggested, grey dashed =
  declared (ends in a ghost box for far ends nobody has loaded). Click a
  wire for the popup: what it is, each end's port info, warnings/errors.
  Click a box to jump to Inspect for that device.
- **Inspect** — read-only settings for one artifact: full object tree, the
  settings transcript with one tab per settings page, and a
  Browse / Aggregate toggle (aggregate = setting names × object scope,
  within the file).
- **Compare** — two files of the same kind (two RTAC projects, ...): union
  tree with added/removed/modified tints and a structured per-item diff.

## Running

```
npm --prefix backend install
npm --prefix frontend install

npm --prefix backend run dev     # Express on 127.0.0.1:3003
npm --prefix frontend run dev    # Vite on 5174, proxies /api
```

`npm --prefix backend test` — parser, diff, service, extractor, and linker
suites.

## AcRTAC access

Identical to rtac-explorer: the backend spawns `backend/py/acrtac_bridge.py`
(SEL's `selacrtac` — `login("admin","TAIL")`, `listprojects()`,
`exportxml(...)`). Requires `python` on PATH with selacrtac installed. If the
database is unreachable, previously exported projects (under
`backend/data/exports/`) stay browsable and the sidebar offers a retry.

## Architecture

```
backend/
  lib/parsers/rtac/      RTAC XML export parser (kind registry, loss-tolerant)
  lib/acrtac/            selacrtac bridge client
  lib/compare.js         file-status + structured item diff
  lib/comm/model.js      CommModel — the normalization boundary
  lib/comm/extract/      one extractor per source type -> DeviceProfile
  lib/comm/linker.js     pure matcher: profiles -> links + tiers + ghosts
  services/projects.js   RTAC source lifecycle, parse cache, tree/item/aggregate
  services/workspaces.js named canvases; graph = extract + link on every read
frontend/
  src/components/ui.tsx  primitive seam (swappable for a design system)
  src/components/        CanvasView (React Flow), SourcesSidebar, FileTree,
                         Preview, DiffPreview, CompareView, AggregateView
```

Links are never stored — every graph read re-runs the extractor + linker over
the current artifacts, so a re-downloaded project immediately re-links.
Workspaces store only placements and manual links (JSON under
`backend/data/workspaces/`).

## Phases

1. **done** — RTAC source + canvas with declared links/ghosts + Inspect +
   Compare.
2. **done** — RDB upload + parser (CFB/QuickSet, ported from Volture) +
   extractor → two-sided matching, conflicts, ghost snapping. The extractor
   is a documented rule table over SEL setting names
   (`backend/lib/comm/extract/rdb.js`) — tune it there when real files show
   variant spellings. A synthetic demo database lives at
   `backend/test/fixtures/demo_relays.rdb`; upload it and place FEEDER_1 /
   METER_3 alongside a sample RTAC project to see confirmed, conflict,
   probable, and ghost-snapping behavior at once.
3. SCD/SCL parser (awaiting example exports) → IEDs, subnet regions, GOOSE.
4. Manual serial pairing UI, RDB-vs-RDB compare, conflict report export,
   canvas snapshot compare.
