// The AcRTAC database catalog — machine-global, unlike everything else in a
// project. The database lists every RTAC project on this machine; each
// projector project then exports the ones it cares about into its own folder
// (see services/rtac.js). One catalog instance is shared by every project's
// RtacService.

class RtacCatalog {
  constructor({ client }) {
    this.client = client;
    this.names = [];
    // Last listprojects failure, or null; served beside every project list.
    this.error = null;
  }

  // (Re-)query the database's project list. Never throws: a failure lands in
  // `error`, which the API returns beside the (possibly export-only) list,
  // and the UI offers a retry that calls this again.
  async refresh() {
    try {
      const projects = await this.client.listProjects();
      this.names = projects.map((project) => project.name);
      this.error = null;
    } catch (err) {
      this.error = err?.message ?? String(err);
    }
    return this.error;
  }
}

export { RtacCatalog };
