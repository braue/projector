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

## Running

- Dev: `npm run dev` in `backend/` and `frontend/` (Vite proxies `/api`).
- Desktop: `npm run app` at the root (Express backend inside Electron).
- Package for Windows: `npm run dist`.

## Tools & Atlas

Machine-global utilities (SEL terminal, QuickSet extract, SWSET, drawing
generator, RTAC exporter) and the field-knowledge atlas live in the top-right
corner, beside any project.
