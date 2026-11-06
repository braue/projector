// The todo board — the one piece of state that is not project data. A single
// machine-global board, so it lives at the top of the data directory rather
// than inside any project (a card may NAME a project; it does not live in one).
//
// It is here, and not in the browser's localStorage, for a specific reason:
// the packaged app listens on port 0, so its window origin
// (http://127.0.0.1:<port>) is a different one on every launch, and anything
// Chromium keys by origin — localStorage included — is effectively wiped each
// time the app starts. The data directory is the only store that survives
// both a relaunch and an upgrade.
//
// Stored whole in <dataDir>/todos.json as one ordered array of cards:
//
//   [{ id, title, description, project, hours, spent, status }]
//
// hours is the estimate and spent the time already put in; the board shows
// what is left (hours - spent).
//
// status is the column (todo | doing | done); a column's order is the array's
// order filtered to that status, so a move is "take it out, put it back
// before that card". Writes are per card, not a whole-board replace from the
// window: a project rename re-keys cards server-side, and a whole-board save
// from a window that has not seen it yet would put the old name straight back.
//
// The file used to be the flat checklist [{ id, text, done }]; those rows read
// as cards in To do / Done.

import { randomUUID } from 'node:crypto';

import { JsonFile } from '../lib/jsonFile.js';
import { httpError } from '../lib/http.js';

const STATUSES = ['todo', 'doing', 'done'];
// An estimate (or time spent) past this is a typo, not a task.
const MAX_HOURS = 10000;

class TodosService {
  constructor({ file, events = null }) {
    this.store = new JsonFile(file, {
      label: 'the todo board',
      empty: () => [],
      clean: (raw) => (Array.isArray(raw) ? raw.map(clean).filter(Boolean) : []),
    });
    this.events = events;
  }

  list() {
    return this.store.read();
  }

  /** `change` edits the board in place; returning false means "no change". */
  async #edit(change) {
    const { doc, changed } = await this.store.update((cards) => (change(cards) === false ? undefined : cards));
    if (changed) this.events?.publish('todos', {});
    return doc;
  }

  /** A new card goes at the bottom of its column. */
  async create(fields) {
    const card = { id: randomUUID(), ...card0(), ...patchOf(fields ?? {}) };
    if (!card.title) throw httpError(400, 'title required');
    return this.#edit((cards) => {
      cards.push(card);
    });
  }

  async update(id, fields) {
    const patch = patchOf(fields ?? {});
    if ('title' in patch && !patch.title) throw httpError(400, 'title required');
    return this.#edit((cards) => {
      const card = find(cards, id);
      Object.assign(card, patch);
    });
  }

  async remove(id) {
    return this.#edit((cards) => {
      cards.splice(cards.indexOf(find(cards, id)), 1);
    });
  }

  /** Into `status`, just above card `before` — or at the bottom of that
   *  column when `before` is null (or not in it). */
  async move(id, status, before = null) {
    const to = statusOf(status);
    return this.#edit((cards) => {
      const card = find(cards, id);
      if (before === id) return false;
      cards.splice(cards.indexOf(card), 1);
      card.status = to;
      const at = cards.findIndex((c) => c.id === before && c.status === to);
      cards.splice(at < 0 ? cards.length : at, 0, card);
    });
  }

  /** Drop everything in Done. */
  async clearDone() {
    return this.#edit((cards) => {
      const kept = cards.filter((c) => c.status !== 'done');
      if (kept.length === cards.length) return false;
      cards.splice(0, cards.length, ...kept);
    });
  }

  /** A project rename carries its cards to the new name. */
  async renameProject(from, to) {
    return this.#edit((cards) => {
      let changed = false;
      for (const card of cards) {
        if (card.project === from) {
          card.project = to;
          changed = true;
        }
      }
      return changed;
    });
  }
}

const card0 = () => ({ title: '', description: '', project: null, hours: null, spent: null, status: 'todo' });

function find(cards, id) {
  const card = cards.find((c) => c.id === id);
  if (!card) throw httpError(404, `no such card: ${id}`);
  return card;
}

function statusOf(status) {
  if (!STATUSES.includes(status)) throw httpError(400, `invalid status: ${status}`);
  return status;
}

/** The editable fields a request names, checked; anything else is ignored. */
function patchOf(fields) {
  const patch = {};
  if ('title' in fields) patch.title = text(fields.title).trim();
  if ('description' in fields) patch.description = text(fields.description).trimEnd();
  if ('project' in fields) patch.project = text(fields.project).trim() || null;
  if ('status' in fields) patch.status = statusOf(fields.status);
  if ('hours' in fields) patch.hours = hoursOf(fields.hours);
  if ('spent' in fields) patch.spent = hoursOf(fields.spent);
  return patch;
}

/** An amount of hours; blank and 0 are "none". */
function hoursOf(raw) {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_HOURS) throw httpError(400, `invalid hours: ${raw}`);
  return Math.round(n * 100) / 100 || null;
}

const storedHours = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const text = (value) => (typeof value === 'string' ? value : '');

/** Keep only well-formed cards, and only the fields we store — the file is
 *  hand-editable, and the old checklist rows ({ text, done }) come through as
 *  cards. */
function clean(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const title = text(raw.title ?? raw.text).trim();
  if (!title) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : raw.done === true ? 'done' : 'todo';
  return {
    id: raw.id,
    title,
    description: text(raw.description).trimEnd(),
    project: text(raw.project).trim() || null,
    hours: storedHours(raw.hours),
    spent: storedHours(raw.spent),
    status,
  };
}

export { TodosService, STATUSES };
