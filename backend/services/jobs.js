// The job registry — every piece of background work in the app, in one
// place: tool runs, AcRTAC downloads into a project tree, imports into the
// AcRTAC database, opening the AcRTAC GUI. A job is started by a service,
// runs to completion regardless of who is watching, and every change to it
// is published on the event hub (lib/events.js), which the window's tasks
// popover and each tool's log panel follow — nothing polls.
//
// Machine-wide, and in-process only like the rest of the app's runtime
// state: jobs do not survive a restart, which is fine for a single-user
// desktop backend — the work they describe either finished (its files are
// where they landed) or is worth redoing.
//
// A job's shape: { id, label, status: 'running' | 'done' | 'error', waiting,
// progress, log, result, error, meta, startedAt, endedAt }. `waiting` is a
// reason the job is queued behind something (another AcRTAC session) or
// null once it is actually working. `meta` is what the job is ABOUT, for
// whoever shows it — e.g. a tree download carries { type: 'rtac-export',
// project, path, … }. `retryable` says a failed job can be started again
// as it was (the tasks popover's ↻) — its starter passed a `retry`.
//
// A running job can be ABORTED (the tasks popover's ■): it settles at once
// as failed with the error "Aborted", and the handle's `signal` fires so the
// work stops — every Python bridge started with the handle (runStdinBridge's
// `job`) kills its whole process tree, or never starts if it was still
// queued. Work that doesn't watch the signal runs on unseen and its result
// is dropped.

import { httpError } from '../lib/http.js';

const MAX_LOG_LINES = 500;
const MAX_FINISHED_JOBS = 50;
// A chatty job (a bridge narrating every file) republishes at most this often.
const PUBLISH_MS = 150;

class JobRegistry {
  #jobs = new Map();
  #counter = 0;
  #timers = new Map();
  // id -> () => the new job's id, for jobs started with `retry`.
  #retries = new Map();
  // id -> AbortController, while the job runs.
  #aborts = new Map();

  /** `events` is the hub jobs publish on; optional so services can be
   *  tested with a bare registry. */
  constructor({ events = null } = {}) {
    this.events = events;
  }

  /**
   * Start `fn` and track it. `fn` receives a handle { log, progress,
   * waiting, running, signal } and its resolved value becomes the job result; a
   * rejection becomes the job error. `meta` rides along untouched.
   * `retry`, if given, starts the same work again (and returns its new job
   * id) — offered once this job has failed.
   */
  start(label, fn, { meta = null, retry = null } = {}) {
    const id = `job-${++this.#counter}`;
    const job = {
      id,
      label,
      status: 'running',
      /** Why the job is queued, or null while it works. */
      waiting: null,
      /** 0..1 when the work can estimate, null when it cannot. */
      progress: null,
      log: [],
      result: null,
      error: null,
      meta,
      retryable: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.#jobs.set(id, job);
    if (retry) this.#retries.set(id, retry);
    const controller = new AbortController();
    this.#aborts.set(id, controller);
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
    const handle = {
      /** Fires when the user aborts the job: stop, and clean up. */
      signal: controller.signal,
      log: (line) => {
        job.log.push(String(line));
        if (job.log.length > MAX_LOG_LINES) job.log.shift();
        this.#changed(job);
      },
      progress: (value) => {
        job.progress = value;
        this.#changed(job);
      },
      /** Queued behind something: say what. */
      waiting: (reason) => {
        job.waiting = String(reason);
        this.#changed(job, true);
      },
      /** The wait is over; the work has begun. */
      running: () => {
        if (job.waiting === null) return;
        job.waiting = null;
        this.#changed(job, true);
      },
    };
    this.#publish(job);
    const work = Promise.resolve().then(() => fn(handle));
    work.catch(() => {}); // an aborted job's work may still fail behind it
    Promise.race([work, aborted])
      .then(
        (result) => {
          job.status = 'done';
          job.result = result ?? null;
        },
        (err) => {
          job.status = 'error';
          job.error = err?.message ?? String(err);
          job.retryable = this.#retries.has(id);
        },
      )
      .finally(() => {
        this.#aborts.delete(id);
        job.waiting = null;
        job.endedAt = new Date().toISOString();
        this.#changed(job, true);
        this.#trim();
      });
    return job;
  }

  get(id) {
    const job = this.#jobs.get(id);
    if (!job) throw httpError(404, `no such job: ${id}`);
    return job;
  }

  list() {
    return [...this.#jobs.values()];
  }

  /** Jobs still working whose meta matches every key of `where`. */
  active(where) {
    return this.list().filter((job) => job.status === 'running'
      && Object.entries(where).every(([key, value]) => job.meta?.[key] === value));
  }

  /** Forget a finished job (the popover's ✕). Running ones can't be. */
  remove(id) {
    const job = this.get(id);
    if (job.status === 'running') throw httpError(409, 'that job is still running');
    this.#drop(job);
  }

  /** Stop a running job (the popover's ■). It settles as failed, "Aborted";
   *  its bridges kill their process trees (see the header). */
  abort(id) {
    const job = this.get(id);
    if (job.status !== 'running') throw httpError(409, 'that job has already finished');
    job.log.push('Aborted by user.');
    this.#aborts.get(id)?.abort();
  }

  /** Start a failed job's work again; the failed one is forgotten.
   *  Resolves to the new job's id. */
  async retry(id) {
    const job = this.get(id);
    const again = this.#retries.get(id);
    if (job.status !== 'error' || !again) throw httpError(409, 'that job cannot be retried');
    const next = await again();
    this.#drop(job);
    return next;
  }

  /** Forget every finished job. */
  clearFinished() {
    for (const job of this.list()) {
      if (job.status !== 'running') this.#drop(job);
    }
  }

  /** What the event stream carries: everything but the result, which can be
   *  large and is only wanted once, by whoever started the job (GET it). */
  static summary(job) {
    const { result: _result, ...rest } = job;
    return rest;
  }

  #drop(job) {
    this.#jobs.delete(job.id);
    this.#retries.delete(job.id);
    clearTimeout(this.#timers.get(job.id));
    this.#timers.delete(job.id);
    this.events?.publish('job-removed', { id: job.id });
  }

  #changed(job, now = false) {
    if (now) {
      clearTimeout(this.#timers.get(job.id));
      this.#timers.delete(job.id);
      this.#publish(job);
      return;
    }
    if (this.#timers.has(job.id)) return;
    this.#timers.set(job.id, setTimeout(() => {
      this.#timers.delete(job.id);
      this.#publish(job);
    }, PUBLISH_MS));
  }

  #publish(job) {
    if (this.#jobs.has(job.id)) this.events?.publish('job', JobRegistry.summary(job));
  }

  // Finished jobs are kept for late viewers, but not forever: oldest settled
  // ones fall off once the registry grows past the cap. Running jobs never do.
  #trim() {
    const settled = this.list().filter((job) => job.status !== 'running');
    for (const job of settled.slice(0, Math.max(0, settled.length - MAX_FINISHED_JOBS))) {
      this.#drop(job);
    }
  }
}

export { JobRegistry };
