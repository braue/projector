// Search everywhere — one string across EVERY project: every settings source
// (RTAC exports, RDB/SCD/SW profiles) plus the project's notes. This is the
// "which job used 10.30.4.x" question: after twenty substations nobody
// remembers which project holds a value, and per-project search makes you
// guess the project first.
//
// Fan-out, not a new matcher: each source is searched by the project's own
// SearchService (the same matching Inspect › Search uses) with tight caps, so
// a hit here is a pointer to open there, not the full listing. Projects run
// sequentially on purpose — the first search may parse artifacts that have
// never been read, and paying that one project at a time bounds memory.
//
// One broken source must never sink the whole answer: per-source failures are
// collected and reported beside the results.

import { httpError } from '../lib/http.js';

/** Per-source caps: a taste of each source, not its full listing. */
const MAX_ITEMS_PER_SOURCE = 5;
const MAX_MATCHES_PER_ITEM = 3;
/** Note lines are shown whole-ish; a pathological line still gets clipped. */
const MAX_NOTE_LINE = 400;

const clip = (text) => (text.length <= MAX_NOTE_LINE ? text : `${text.slice(0, MAX_NOTE_LINE)}…`);

class GlobalSearch {
  // `projects` is the ProjectsService — the one place that knows every
  // project and can build its service bundle.
  constructor({ projects }) {
    this.projects = projects;
  }

  /** Every searchable source in one project's bundle, as { type, ref }. */
  #sourcesOf(bundle) {
    const sources = bundle.rtac.list().projects
      .filter((entry) => entry.status === 'ready')
      .map((entry) => ({ type: 'rtac', ref: entry.name }));
    for (const [type, service] of [['rdb', bundle.rdb], ['scd', bundle.scd], ['sw', bundle.sw]]) {
      for (const file of service.list()) {
        for (const profile of file.profiles) sources.push({ type, ref: profile.ref });
      }
    }
    return sources;
  }

  #searchNotes(notes, needle) {
    const hits = [];
    for (const note of notes) {
      const matches = [];
      let total = 0;
      if (note.name.toLowerCase().includes(needle)) {
        total += 1;
        matches.push({ location: 'note name', text: note.name });
      }
      note.text.split('\n').forEach((line, index) => {
        if (!line.toLowerCase().includes(needle)) return;
        total += 1;
        if (matches.length < MAX_MATCHES_PER_ITEM) {
          matches.push({ location: `line ${index + 1}`, text: clip(line.trim()) });
        }
      });
      if (total) {
        hits.push({ id: note.id, name: note.name, matches, totalMatches: total, truncated: total > matches.length });
      }
    }
    return hits;
  }

  async search(query) {
    const q = String(query ?? '').trim();
    if (!q) throw httpError(400, 'a search string is required');
    const needle = q.toLowerCase();

    const projects = [];
    const errors = [];
    const fail = (project, source, err) =>
      errors.push({ project, source, error: err?.message ?? String(err) });

    for (const name of await this.projects.list()) {
      let bundle;
      try {
        bundle = await this.projects.bundle(name);
      } catch (err) {
        fail(name, null, err);
        continue;
      }

      const sources = [];
      for (const source of this.#sourcesOf(bundle)) {
        try {
          const found = await bundle.search.search(source, q, {
            maxItems: MAX_ITEMS_PER_SOURCE,
            maxMatchesPerItem: MAX_MATCHES_PER_ITEM,
          });
          if (found.totalMatches) {
            sources.push({
              type: source.type,
              ref: source.ref,
              label: found.label,
              results: found.results,
              totalMatches: found.totalMatches,
              truncated: found.truncated,
            });
          }
        } catch (err) {
          fail(name, `${source.type} · ${source.ref}`, err);
        }
      }

      let notes = [];
      try {
        notes = this.#searchNotes(await bundle.notes.list(), needle);
      } catch (err) {
        fail(name, 'notes', err);
      }

      if (sources.length || notes.length) projects.push({ name, sources, notes });
    }

    return { query: q, projects, errors };
  }
}

export { GlobalSearch };
