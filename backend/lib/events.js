// The event hub — how the backend tells the window something happened,
// instead of the window asking over and over. One Server-Sent Events stream
// (GET /api/events) carries every kind:
//
//   jobs          { jobs: [...] }      the whole registry, sent on connect
//   job           a job's summary      it started, logged, or settled
//   job-removed   { id }               dismissed or aged out
//   tree          { project }          that project's files changed on disk
//   projects      {}                   a project was created/renamed/deleted
//
// A reconnecting window gets the `jobs` snapshot again and re-reads anything
// it shows, so a missed event never leaves it stale.

const HEARTBEAT_MS = 25_000;

class EventHub {
  #clients = new Set();

  publish(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of this.#clients) res.write(frame);
  }

  /** Express handler for the stream. `snapshot()` is what a new client is
   *  sent first, as [[type, data], ...]. */
  handler(snapshot = () => []) {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Reconnect quickly: a gap is a backend restart, over in a second.
      res.write('retry: 1000\n\n');
      for (const [type, data] of snapshot()) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      this.#clients.add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), HEARTBEAT_MS);
      req.on('close', () => {
        clearInterval(beat);
        this.#clients.delete(res);
      });
    };
  }

  /** End every stream (server shutdown — an open stream holds it up). */
  closeAll() {
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }
}

export { EventHub };
