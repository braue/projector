# Projector

A settings workbench for substation devices. One project = one folder tree
holding everything a job is — RTAC exports (via the AcRTAC database or a
folder upload), RDB relay databases, SEL Architect / SCD files, switch
settings exports, PDFs, and plain-text notes — versioned in place, git-style,
and inspectable/comparable without leaving the app.

See `DESIGN.md` for the current design.

## The tree

The left sidebar is the whole model: a real folder structure you organize
yourself. Every entry shows its timestamp and its **version note** — adding a
same-named file does not overwrite or duplicate; it stacks a **new version**
(mandatory "what changed" note), and the `vN` badge accordions out the full
history. Old versions open, inspect, and compare like anything else.

- **Click** a settings artifact → Inspect (settings tree + preview; RTAC also
  gets Aggregate; everything gets Search).
- **Click** a `.txt` → the built-in notes editor (checkboxes, lists).
- **Click** any other file → details + open with the OS default app
  (double-click opens directly).
- **⇆ on a version** → compare it against the current version.
- **Ctrl+click** a second artifact of the same kind → compare those two.
- **Drag** rows between folders; **drop** OS files anywhere to add them.

## Finding things

**Ctrl+F** searches whatever you are reading, in place:

- **Atlas page** — words in the open guide, highlighted, `Enter` /
  `Shift+Enter` to step. Matches run across markup and line breaks, so a
  phrase half of which is bold still matches.
- **Inspect / Compare** — words in the panes on screen (settings tree,
  settings, sheets, diff rows). What is off screen it cannot see, so the bar
  offers **whole artifact**, which hands the term to Inspect's Search.
- **PDF** — the embedded viewer has no find of its own, so the backend reads
  the document's text and answers with **pages**: every hit listed with the
  line it sits in, click one and the viewer goes there.

**Ctrl+Shift+F** always filters the file tree (and plain **Ctrl+F** does too
whenever the pane on the right has no find of its own).

## Running

- Dev: `npm run dev` in `backend/` and `frontend/` (Vite proxies `/api`).
- Desktop: `npm run app` at the root (Express backend inside Electron).
- Package for Windows: `npm run dist`.

## Tools & Atlas

Machine-global utilities (SEL terminal, QuickSet extract, SWSET, drawing
generator, RTAC exporter) and the field-knowledge atlas live in the top-right
corner, beside any project.
