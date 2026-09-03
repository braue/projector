# projector — design document

*A settings workbench for substation automation. Rewritten 2026-09: the
canvas/linker era is gone (see git history for that design); the app is now a
versioned file tree with inspection and comparison built in.*

## What it is

One window, three regions:

```
┌──────────────────────────────────────────────────────────────┐
│ [Project ▾]                       ☑ todos · ⚒ Tools · ◆ Atlas│
├─────────────┬────────────────────────────────────────────────┤
│ THE TREE    │  what the selection is:                        │
│             │                                                │
│ Station A/  │   settings artifact → INSPECT                  │
│  GP.rtac ▸v3│     (Browse | Aggregate | Search, profile      │
│   "rev 2…"  │      picker for RDB/SCD)                       │
│  feeder.rdb │   .txt → built-in editor (notes live here)     │
│  oneline.pdf│   other file → details + OS-default open       │
│ notes.txt   │   two same-kind picks → COMPARE                │
│             │     (union tree, tinted; structured diff)      │
└─────────────┴────────────────────────────────────────────────┘
```

No Canvas, no Files/Compare/Notes tabs. The project switcher is the only
top-left control; Tools and the Atlas hold the top-right, machine-global.

## Core concept: one tree, versioned in place

A project is a real directory (`data/projects/<name>/files/`). Folders are
directories; files keep their names; opening hands the OS a real path
(loopback backend). Settings artifacts are ordinary entries in that tree,
recognized by extension:

| kind | entries |
|------|---------|
| rtac | `<name>.rtac/` — a folder of exported XML, shown as a single leaf |
| rdb  | `.rdb` QuickSet databases (multi-relay) |
| scd  | `.scd .ssd .sed .cid .icd` SCL files (multi-IED) |
| sw   | `.xml .cfg .bin` SEL-2730M switch exports |

**Versions.** Adding a name that already exists in a folder stacks: the live
entry stays the newest version under its plain name; the replaced bytes move
to the folder's hidden `.versions/` directory. Every arrival carries a
mandatory NOTE (what changed) and a timestamp, kept in a per-folder
`.versions.json` sidecar (mtimes don't survive copies between machines).
Renames and moves carry the record and archive along; deleting an entry
deletes its history. Old versions are addressed by their real
`dir/.versions/<stamp>-<name>` path and inspect/compare like any artifact.
Editing a `.txt` in place is NOT a version — versions mark deliberate
arrivals, not autosaves.

**Intake paths that all version the same way:** OS-file drop / upload,
AcRTAC database download (lands in the selected folder as `<name>.rtac`,
staged in a hidden temp dir so a half-written export never looks ready),
exported-folder upload, tool-output save.

## Backend

Node/Express (loopback), per-project service bundle:

```
services/files.js     the tree: bytes, versions sidecar, text save, OS open
lib/artifacts.js      meaning: kind registry, refs, bounded parse cache,
                      RTAC intake (catalog export + folder upload)
services/rdb|scd|sw   ArtifactKind subclasses: parse + inspect sections
                      (RtacKind lives in lib/artifacts.js)
services/compare.js   union tree + structured diff over one loader
services/search.js    free-text search over the same loader
```

Refs: an artifact is its tree path; a profile inside one is
`"<path>::<profile>"` (`:` is invalid in names, so no collisions). Kind is
derived server-side; compare rejects mismatched kinds.

### Memory (the reason artifacts.js exists)

A large RTAC export (GP Naheola: ~550 MB of XML, 180+ files) parses into a
model of **1.3 GB retained / 2.7 GB peak** — measured. The backend lives in
the Electron main process, so the old design (every parsed model cached
forever, all XML strings read before parsing) blew V8's ~4 GB ceiling after
inspecting/comparing a few exports and killed the whole app. Now:

- parse cache is LRU with per-weight caps: 2 heavy (RTAC), 12 light —
  compare needs exactly two models live;
- RTAC parses one file at a time (read → parse → hash → drop the string);
- electron/main.js raises `--max-old-space-size` to 12 GB as margin;
- a GPU-process crash (seen on NVIDIA/Linux: Chromium aborts with "GPU
  process isn't usable") writes a marker and relaunches into software
  rendering; Help > Re-enable GPU acceleration opens the way back.

## Frontend

React/Vite, ui.tsx primitive seam preserved.

```
components/ProjectTree.tsx   THE sidebar: folders, artifact rows (kind badge,
                             inline note + timestamp, vN accordion), drop
                             uploads → VersionNoteModal, RTAC intake, filter
components/InspectView.tsx   header bar (title · Browse/Aggregate/Search ·
                             profile picker) over FileTree + Preview
components/CompareView.tsx   union tree + DiffPreview for two refs
components/TextFileView.tsx  the notes editor (checkbox overlay, list markers)
components/VersionNoteModal  the mandatory what-changed dialog
```

Selection model in App: `selected` (path, live or version) + `compareTo`
(the original side). ⇆ on a version row compares it to the live entry;
ctrl+click picks any second artifact.

## Decisions taken

- Canvas, linker, CommModel, network review: **removed** (2026-09-02).
- Notes are `.txt` files in the tree; the notes.json service is gone.
- No migration of pre-tree project layouts (old rtac/rdb/scd/sw stores are
  simply ignored).
- Compare = any two same-kind refs; the same-artifact version compare is the
  one-click case.
- AcRTAC downloads land in the currently selected folder.
