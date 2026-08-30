# Atlas content

The field-knowledge library's ONE home. Every document in here is embedded
into the app at build time (`content.ts` glob-imports the folder), so adding
or editing a guide is: drop the file, rebuild. Nothing outside this repo is
involved.

Layout: `<category>/<file>`, with an optional one-level group folder
(`data-protocols/dnp3/fundamentals.html`). Category ids must match
`CATEGORIES` in `../content.ts`; a folder not listed there shows up as an
auto-generated category at the end of the rail. `start-here/` is deliberately
filtered out (`DROPPED_CATEGORIES`) — files there are inert.

- `.md` — optional frontmatter (`title` / `summary` / `tags` / `order`),
  rendered natively in the app's reading column.
- `.html` — standalone field-guide pages, embedded whole in an iframe and
  reskinned to projector's palette at render time.
  `<meta name="atlas-order">` sets reading position,
  `<meta name="atlas-tags">` adds search tags, and `atlas:<doc id>` hrefs
  cross-link between documents.

This file itself sits above any category folder, so the importer ignores it.

**Migrating from the old standalone atlas repo**: copy that repo's
`content/` directories straight into this folder — categories, groups and
files land unchanged.
