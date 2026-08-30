// In-memory job registry for the slow tool operations (database dumps,
// drawing fetches, bulk exports). A job is started by a tool route, runs to
// completion regardless of who is watching, and is polled by the UI at
// /api/tools/jobs/:id — the same poll-until-settled shape as RTAC exports.
//
// In-process only, like the rest of the app's runtime state: jobs do not
// survive a restart, which is fine for a single-user desktop backend — the
// work they describe either finished (its files are in the run workspace)
// or is worth redoing.

import { httpError } from '../../lib/http.js';

const MAX_LOG_LINES = 500;
const MAX_FINISHED_JOBS = 50;

class JobRegistry {
  #jobs = new Map();
  #counter = 0;

  /**
   * Start `fn` and track it. `fn` receives { log, progress } and its resolved
   * value becomes the job result; a rejection becomes the job error.
   */
  start(label, fn) {
    const id = `job-${++this.#counter}`;
    const job = {
      id,
      label,
      status: 'running',
      /** 0..1 when the work can estimate, null when it cannot. */
      progress: null,
      log: [],
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
    };
    this.#jobs.set(id, job);
    const handle = {
      log: (line) => {
        job.log.push(String(line));
        if (job.log.length > MAX_LOG_LINES) job.log.shift();
      },
      progress: (value) => {
        job.progress = value;
      },
    };
    Promise.resolve()
      .then(() => fn(handle))
      .then(
        (result) => {
          job.status = 'done';
          job.result = result ?? null;
        },
        (err) => {
          job.status = 'error';
          job.error = err?.message ?? String(err);
        },
      )
      .finally(() => this.#trim());
    return job;
  }

  get(id) {
    const job = this.#jobs.get(id);
    if (!job) throw httpError(404, `no such job: ${id}`);
    return job;
  }

  // Finished jobs are kept for late pollers, but not forever: oldest settled
  // ones fall off once the registry grows past the cap. Running jobs never do.
  #trim() {
    const settled = [...this.#jobs.values()].filter((job) => job.status !== 'running');
    for (const job of settled.slice(0, Math.max(0, settled.length - MAX_FINISHED_JOBS))) {
      this.#jobs.delete(job.id);
    }
  }
}

export { JobRegistry };
