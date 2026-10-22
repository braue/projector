// Billable hours — how long went into each project on each day, and the
// budget each project is billed against. Machine-global like the todo list
// (one person, many projects in a week), so it lives at the top of the data
// directory rather than inside any project, and for the same reason as the
// todo list it is not in localStorage: the window origin changes every launch.
//
// Stored whole in <dataDir>/hours.json:
//
//   { budgets: { <project>: hours },
//     days:    { "YYYY-MM-DD": { <project>: hours } } }
//
// Writes are per cell (one day of one project, or one budget), not a
// whole-file replace from the window: a rename re-keys the file server-side,
// and a whole-document save from a window that has not seen it yet would put
// the old name straight back.

import { httpError } from '../lib/http.js';
import { JsonFile } from '../lib/jsonFile.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// No single day bills past 24, and no budget is negative.
const MAX_DAY = 24;

class HoursService {
  constructor({ file, events = null }) {
    this.store = new JsonFile(file, {
      label: 'the hours',
      empty: () => ({ budgets: {}, days: {} }),
      clean,
    });
    this.events = events;
  }

  get() {
    return this.store.read();
  }

  /** `change` edits the document in place; returning false means "no change". */
  async #edit(change) {
    const { doc, changed } = await this.store.update((doc) => (change(doc) === false ? undefined : doc));
    if (changed) this.events?.publish('hours', {});
    return doc;
  }

  /** Set one project's hours on one day; 0 clears the cell. */
  setDay(date, project, hours) {
    if (typeof date !== 'string' || !DATE.test(date)) throw httpError(400, `invalid date: ${date}`);
    const name = projectName(project);
    const value = amount(hours, MAX_DAY);
    return this.#edit((doc) => {
      const day = doc.days[date] ?? {};
      if (value) day[name] = value;
      else delete day[name];
      if (Object.keys(day).length) doc.days[date] = day;
      else delete doc.days[date];
    });
  }

  /** Set one project's budget; 0 clears it. */
  setBudget(project, hours) {
    const name = projectName(project);
    const value = amount(hours, Infinity);
    return this.#edit((doc) => {
      if (value) doc.budgets[name] = value;
      else delete doc.budgets[name];
    });
  }

  /** A project rename carries its hours and budget to the new name. */
  renameProject(from, to) {
    return this.#edit((doc) => {
      let changed = false;
      const move = (bag) => {
        if (!(from in bag)) return;
        bag[to] = (bag[to] ?? 0) + bag[from];
        delete bag[from];
        changed = true;
      };
      move(doc.budgets);
      for (const day of Object.values(doc.days)) move(day);
      return changed;
    });
  }
}

function projectName(project) {
  const name = typeof project === 'string' ? project.trim() : '';
  if (!name) throw httpError(400, 'project required');
  return name;
}

function amount(hours, max) {
  const value = Number(hours);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw httpError(400, `invalid hours: ${hours}`);
  }
  // Quarter-hour resolution is finer than any timesheet; float noise
  // (0.1 + 0.2) must not ride into the file.
  return Math.round(value * 100) / 100;
}

/** The file is hand-editable, so its shape is checked on the way in. */
function clean(raw) {
  const bag = (obj) => {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [key, value] of Object.entries(obj)) {
      const n = Number(value);
      if (key.trim() && Number.isFinite(n) && n > 0) out[key] = n;
    }
    return out;
  };
  const days = {};
  for (const [date, day] of Object.entries(raw?.days ?? {})) {
    if (!DATE.test(date)) continue;
    const cleaned = bag(day);
    if (Object.keys(cleaned).length) days[date] = cleaned;
  }
  return { budgets: bag(raw?.budgets), days };
}

export { HoursService };
