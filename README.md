# Projector

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
  wire for the popup: what it is, each end's port info, and its checklist.
  Click a box to jump to Inspect for that device.

  **Every link shows what was checked, not just what broke.** The linker
  records each question it asked and the answer it got — ✓ agreed, ✕ disagreed,
  ! worth a look, – could not be asked because one side states nothing. A green
  wire is not a bare assurance; open it and you can read the port, protocol,
  addressing, route and layer-2 comparisons that earned it. An unanswered check
  is as informative as a failed one: it marks where the settings are silent
  rather than agreed, and silence is never read as agreement.

  **A wire is a physical run, and connections ride it.** Where you have drawn
  the cables, an inferred link does not get a wire of its own — the linker
  resolves it onto the run it actually travels (`link.path`) and the canvas
  paints those cables for it. An RTAC three switches from a relay reads as
  three cables, not as three cables plus a chord cutting across them. Each
  cable takes the *worst* tier riding it, so one broken connection turns its
  whole run red — that run is where you have to go looking. Because a
  connection now knows the run it takes, **layer-2 membership is checked for
  every link, not just for GOOSE**: the walk searches the drawn fabric for a
  path on which one VLAN survives every hop, and names the port that drops it
  when none does. A switch that states no VLAN table leaves the check
  unanswered rather than failing it. The wire's popup
  lists what it carries; clicking one of those lights its whole path end to
  end, and hovering a box lights everything that talks to it. With no drawn
  cables the topology isn't stated, and links stay direct as before.
- **Inspect** — read-only settings for one artifact: full object tree, the
  settings transcript with one tab per settings page, and a
  Browse / Aggregate toggle (aggregate = setting names × object scope,
  within the file).
- **Compare** — two files of the same kind (two RTAC projects, ...): union
  tree with added/removed/modified tints and a structured per-item diff.

## Atlas

The atlas is **not** a mode. The mode row on the left of the topbar is
project-specific — every one of those views acts on the current project's
sources — while the atlas is reference material that reads the same whatever
project is open. So it toggles from a button in the topbar's far-right
corner and takes over the whole pane while it is on.

The corner is the atlas's, not the project switcher's, so the toggle never
moves. The switcher sits to its left and **disappears entirely** while the
atlas is up: nothing on screen is scoped to a project then, so offering to
change the project would be offering to change nothing.

It mounts the first time you open it and stays mounted after that, so a
half-read page and its scroll position are still there when you come back from
the project. `AtlasView` takes an `active` prop for exactly that reason: while
it is hidden it must not swallow the `/` search shortcut meant for the pane you
can actually see. It is also a `React.lazy` import — the embedded library is
2.6 MB of document source, and a canvas session that never opens the atlas
should not pay to parse it.

The library is embedded whole. It reads `Desktop/atlas/content/` directly
(glob-imported across repos; the dev server allows it via `vite.config.ts`
`server.fs.allow`), so the atlas repo stays the single home for the documents
and its standalone app keeps working. Category rail with full-text search,
documents with an "On this page" rail, prev/next, and `atlas:` cross-document
links.

**It is styled as a pane of projector, not as an embedded app.** `atlas.css`
draws every color from `index.css`'s tokens and follows the same house rules —
no raw hex, no uppercase/letter-spaced labels, 16px pane gutters, `.ui-*`
primitives where one fits — the search box *is* `.ui-input`, the home tabs
*are* `TabBar`, the counts *are* `.ui-count`. The `atl-` prefix scopes layout,
not a second theme.

HTML field guides render in an iframe and get `DOC_SKIN` (in
`src/components/AtlasView.tsx`) injected before `</head>` at render time,
screen-only so the pages' own print styles survive. An iframe is a separate
document and cannot inherit the parent's custom properties, so the token
*values* have to be restated inside the frame — but they are read off the
parent with `getComputedStyle` at render time rather than copied into the
source. What is listed by hand is `SKIN_TOKENS`, a list of **names**: adding a
token to the skin means naming it there, and the two can never drift apart on
a value.

The one thing the atlas keeps at its own scale is the document reading column:
long-form prose at 14.5px/1.7, where a settings table reads at 12.5px. That is
a reading decision, not a theme — the typeface and palette are projector's.

`src/atlas/{content,search}.ts` are copies of the atlas repo's `src/` modules
— keep them in step; only the glob paths and the `atl-` class prefix differ.
The *styling* has deliberately diverged: the standalone atlas app keeps its
OpenAI-docs look, this copy wears projector's.

## Searching the SEL documents

One term, two corpora, atlas first:

| Block | Corpus | What is matched |
|---|---|---|
| *(atlas guides)* | the 82 atlas guides | title, tags, and **full body text** — figure labels included |
| **In SEL documents** | 124,202 pages of SEL PDFs | **full text**, one hit per page |

The guides come first because they are the written-for-you answer; the SEL
pages below are the primary source behind it. A page hit opens that PDF at
that page in your viewer.

**The two halves are deliberately hard to confuse.** Each gets a titled header
saying what it is and where it opens, and the SEL half sits on a `--fill`
band, ruled top and bottom, running the full width of the rail — a change of
ground is the clearest boundary available, and `--bg` was tried first and is
a percent off white, so it carried nothing. Every SEL row also carries a `↗`,
because that click leaves the application.

There is deliberately no search-by-model-number. A model is just another term,
and the full text finds it in the manuals that are actually about it — ranking
does the work that a separate lookup used to.

### The index

Full text needs an index — `sel_fulltext.sqlite`, an SQLite FTS5 database of
one row per page. For the current library that is **1,412 documents, 124,202
pages, 435 MB, built in about 13 minutes** with zero extraction failures. The app opens it **read-only** and looks for it in order:
`$SEL_FULLTEXT`, then beside the library (`C:\SEL\sel_fulltext.sqlite`), then
in the app's data folder, then the copy the installer shipped. No index at all
means the block simply does not appear; nothing else changes.

**The installer carries one.** `build.extraResources` in `package.json` packages
the index beside `app.asar`, so a fresh machine searches all 124,202 pages the
moment it is installed — no build step, no poppler, nothing to copy. It costs
about 98 MB of installer (the FTS index compresses well, 435 MB down to that),
and it is why the build machine needs the library present: `extraResources`
names `C:/SEL/sel_fulltext.sqlite`, the one place a build states where the
library lives.

The shipped copy is deliberately **last** in that order. An index sitting beside
a library was built from that library and may be newer than the one packaged
months earlier, so it wins; the shipped copy is a floor, never an override.
Note the index is self-contained but the *documents* are not — search works
without the PDFs, opening a hit needs the real file under `$SEL_LIBRARY`.

Build it with:

```
npm run sel:index
```

This needs **poppler's `pdftotext`**, which the app deliberately does not
bundle — a general user should never have to install it. Instead the index is
built once by whoever curates the library and **travels with the PDFs**: the
library is already a multi-gigabyte folder people copy around, and one more
file beside it costs nothing. Re-run after adding documents; unchanged files
are skipped, so a top-up only pays for what is new.

`--library`, `--out`, `--jobs` and `--limit` are all overridable; `--limit 20`
is a quick smoke test.

### Why results are grouped by document type

Instruction manuals are **91% of the indexed pages** (112,878 of 124,202) while
being 22% of the documents. A flat bm25 list is therefore almost entirely
manual: `reclosing` used to return 28 manual pages out of 30, and the
application guide that actually explains reclosing never appeared at all.

So each document type that matched gets its own section — Instruction Manuals,
Application Guides, Data Sheets, Ordering Information — up to 8 pages each,
with the **best-matching type first**. That ordering adapts per query: search
`ordering` and Ordering Information leads; search a setting name and the
manuals do.

### Why page-level

"The SEL-411L manual mentions this" is close to useless against a 1,698-page
document. One row per page gives a real answer, a snippet worth reading, and a
`#page=` deep link. Results are ranked by bm25 with **at most three pages from
any one document**, so a manual that says *differential* on every other page
cannot crowd out everything else.

Queries are built rather than passed through, because FTS5's query language is
a syntax and people type prose: each word becomes a required prefix term, so
`reclos` finds *reclosing* and *RECLOSURES*; `"trip coil"` stays a phrase; and
stray punctuation is dropped instead of throwing.

## Installing

Projector ships as a Windows desktop app. Build the installer:

```
npm install          # first time: electron + electron-builder
npm run setup        # first time: backend and frontend dependencies
npm run dist
```

`release/Projector-Setup-<version>.exe` is the result — a per-user one-click
NSIS installer, so it needs no administrator rights and asks no questions. It
installs to `%LOCALAPPDATA%\Programs\Projector`, creates the Desktop and Start
Menu shortcuts, and launches the app when it finishes.

Nothing else has to be on the machine. Node and Chromium are bundled. Python
is *not*, and is only needed for the AcRTAC database panel — see below.

`npm run dist:dir` skips the installer and leaves a runnable folder in
`release/win-unpacked/`, which is much faster when you are iterating on the
shell.

The same installer is also how you upgrade — see **Updating and
uninstalling**. Projector never reaches the network; there is nothing to
configure and nothing to allow through a firewall.

### Where things live once installed

| | |
|---|---|
| Program | `%LOCALAPPDATA%\Programs\Projector` |
| Projects, uploads, canvases | `%APPDATA%\Projector\data` |
| SEL document library | `C:\SEL` (not bundled — see Searching the SEL documents) |

The data directory is deliberately outside the install: Program Files is
read-only for a normal user, so a store next to the code would make projects
unsaveable. It also survives uninstalling and reinstalling.

## Updating and uninstalling

**An update is an installer you hand someone.** Nothing polls, nothing phones
home, and the app never touches the network — it works exactly the same on a
machine that has never seen the internet.

To ship a build:

```
npm run version:patch     # 0.2.3 -> 0.2.4 (or version:minor)
npm run dist
```

Put `release/Projector-Setup-<version>.exe` wherever people get files —
a share, a USB stick, an email. They double-click it. That is the whole
process.

### What the double-click does

It is a **one-click installer**: no wizard, no questions, no directory prompt.
It closes Projector if it is running, replaces the program, and relaunches it.
About half a minute end to end, and it works the same whether the app is open
or closed. There is no separate "upgrade" build — the same installer does a
first install and an upgrade, and it will happily install an older version if
you need to go back.

Closing the running app is done by `build/installer.nsh`, and it matters: the
stock check does not reliably terminate a per-user one-click install, and a
running Projector holds its own program files open, so the installer stalls at
"Installing, please wait…" with no way forward. Losing the process costs
nothing — every project write lands on disk when the API call is made.

Your projects, uploads and canvases are untouched by all of this. They live in
`%APPDATA%\Projector\data`, outside the install directory, and survive
upgrades, downgrades and uninstalls alike.

### Which version am I running?

The project menu in the top right shows it at the foot of the dropdown, and
Help → *Projector x.y.z* in the menu bar says the same. It comes from
`/api/health`, so it is the version actually running, not one baked into the
page.

### Uninstalling

Settings → Apps → Projector → Uninstall, or `Uninstall Projector.exe` in
`%LOCALAPPDATA%\Programs\Projector`. Per-user, no administrator rights.
Projects are deliberately left behind; delete `%APPDATA%\Projector` yourself
to start genuinely clean.

## Running from source

```
npm run setup                    # first time

npm --prefix backend run dev     # Express on 127.0.0.1:3003
npm --prefix frontend run dev    # Vite on 5174, proxies /api
```

`npm run app` builds the frontend and opens it in the desktop shell — the
packaged arrangement, without packaging. `npm run app:dev` points the shell at
a Vite dev server you are already running (`PROJECTOR_DEV_URL`, default
`http://127.0.0.1:5174`) and opens devtools, so the desktop window is
debuggable with hot reload.

`npm --prefix backend test` — parser, diff, service, extractor, and linker
suites.

### The two entry points

`backend/server.js` exports `startServer({port, dataDir, staticDir})` and is
the whole app. Two things call it:

- `backend/index.js` — development. Fixed port, data next to the code, no
  static serving, because Vite is in front serving the UI and proxying `/api`.
- `electron/main.js` — packaged. **Port 0**, so the OS picks a free one and the
  window is told where to look (the installed app cannot assume 3003 is free).
  **Data under `app.getPath('userData')`.** **Static serving on**, so the UI and
  API share one origin and there is no proxy in the picture.

## AcRTAC access

Identical to rtac-explorer: the backend spawns `backend/py/acrtac_bridge.py`
(SEL's `selacrtac` — `login("admin","TAIL")`, `listprojects()`,
`exportxml(...)`). Requires `python` on PATH with selacrtac installed.

**This is the one optional part of the app, and the packaged build ships
without it.** Python is not bundled — selacrtac is an SEL package and not ours
to redistribute — so on a fresh install the database panel reports, in a
sentence rather than a traceback, that Python or selacrtac is missing and that
everything else works. Install both and it lights up with no other change.
Previously exported projects stay browsable either way, and the sidebar offers
a retry.

The bridge script is listed in electron-builder's `asarUnpack`: Python is a
separate process and cannot read into `app.asar`, so it needs a real file on
disk.

## Architecture

```
electron/main.js         desktop shell: starts the server, owns the window
build/installer.nsh      NSIS hook: close a running Projector before replacing it
backend/
  server.js              the app itself — startServer({port, dataDir, staticDir})
  index.js               dev entry (fixed port, API only, Vite in front)
  lib/parsers/rtac/      RTAC XML export parser (kind registry, loss-tolerant)
  lib/acrtac/            selacrtac bridge client
  lib/compare.js         file-status + structured item diff
  lib/comm/model.js      CommModel — the normalization boundary
  lib/comm/extract/      one extractor per source type -> DeviceProfile
  lib/comm/linker.js     pure matcher: profiles -> links + tiers + ghosts
  services/projects.js   RTAC source lifecycle, parse cache, tree/item/aggregate
  services/workspaces.js named canvases; graph = extract + link on every read
  services/selLibrary.js the SEL PDF library: is it there, and open a file
  services/selFullText.js FTS5 page-level search over the same PDFs (read-only)
tools/build-sel-index.mjs builds that index with pdftotext (run by hand)
frontend/
  src/atlas/selDocs.ts   client for /api/sel
  src/components/ui.tsx  primitive seam (swappable for a design system)
  src/components/        CanvasView (React Flow), SourcesSidebar, FileTree,
                         Preview, DiffPreview, CompareView, AggregateView
```

Links are never stored — every graph read re-runs the extractor + linker over
the current artifacts, so a re-downloaded project immediately re-links.
Workspaces store only placements and manual links (JSON under
`backend/data/workspaces/`).

### Styling

One stylesheet, `frontend/src/index.css`, in two halves: tokens + the `ui-*`
primitives that `components/ui.tsx` renders, then layout. Its header carries
the house rules; the short version:

- **Color comes from a token.** Green/red/amber especially — `--ok`, `--bad`,
  `--warn`, each with an `-ink`, a `-tint`, and a `-tint-hover`. Adding a raw
  hex in that family is how the amber tint quietly forked into three shades.
- **Elevation comes from `--shadow-*`**, four steps from a resting card to the
  modal.
- **Panes gutter at 16px, floating surfaces at 14px** — that difference is
  what makes a popup read as laid over the app rather than part of it.
- **State classes**: `.active` for the current tab or segment, `.selected` for
  the open row in a list or tree, `.on` for a pressed toggle button.
- **Check `ui.tsx` before hand-rolling a control.** The sidebar's source tabs
  were a separately-styled second segmented control until they were folded
  back into `SegmentedControl`'s `fill` variant, and the atlas home tabs were
  a second `.ui-tabbar` until they were folded into `TabBar`.

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
