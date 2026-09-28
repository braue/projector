// The AcRTAC database catalog — the one list of RTAC projects on this
// machine, read once and shared by everything that picks a database project:
// the tree's "Download from AcRTAC", the RTAC Exporter, RTAC VLAN Deploy.
// Reading it means a Python + AcRTAC session (seconds), so it is cached and
// re-read only on request (a picker's Refresh) or after something changes
// the database (an import).
//
// Served at /api/acrtac/projects as { projects, error }: a failed read keeps
// the last good list and reports why beside it, so the pickers can show both.

class RtacCatalog {
  constructor({ client }) {
    this.client = client;
    this.names = [];
    // Last listprojects failure, or null.
    this.error = null;
    this.loaded = false;
    this.#pending = null;
  }

  #pending;

  /** (Re-)read the database's project list. Never throws: a failure lands
   *  in `error`. Concurrent calls share one read. */
  refresh() {
    this.#pending ??= (async () => {
      try {
        this.names = await this.client.listProjects();
        this.error = null;
      } catch (err) {
        this.error = err?.message ?? String(err);
      } finally {
        this.loaded = true;
        this.#pending = null;
      }
      return this.error;
    })();
    return this.#pending;
  }

  /** The list, reading it first if it never has been (or is mid-read). */
  async list() {
    if (!this.loaded || this.#pending) await this.refresh();
    return { projects: this.names, error: this.error };
  }
}

export { RtacCatalog };
