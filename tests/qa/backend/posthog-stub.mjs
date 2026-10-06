// A stub PostHog endpoint for QA runs. Builds under test point VITE_POSTHOG_HOST at it, so every
// analytics request the product makes is recorded locally and nothing reaches PostHog. It answers
// the `/batch/` endpoint the analytics client uses (packages/core/src/analytics/client.ts) and the
// other PostHog ingestion paths with 200, so an unexpected path is recorded rather than retried.
// Loopback only.
import { createServer } from "node:http";

const INGEST = /^\/(batch|capture|e|i\/v0\/e|track|engage|decide|flags)\/?(\?.*)?$/;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Start the stub. `requests` holds every request; `events()` flattens batches to {event, properties}. */
export async function startPosthogStub({ port = 0 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed: raw.slice(0, 2000) }; }
      requests.push(Object.freeze({
        method: req.method, path: req.url, receivedAt: Date.now(),
        contentType: req.headers["content-type"] ?? null, body,
      }));
      const known = INGEST.test(req.url ?? "");
      res.writeHead(known ? 200 : 404, { ...CORS, "content-type": "application/json" });
      res.end(known ? JSON.stringify({ status: 1 }) : "{}");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: bound } = server.address();
  return {
    url: `http://127.0.0.1:${bound}`,
    requests,
    events() {
      return requests.flatMap(request => {
        const body = request.body;
        if (!body || typeof body !== "object") return [];
        const list = Array.isArray(body.batch) ? body.batch : Array.isArray(body) ? body : [body];
        return list.filter(item => item && typeof item.event === "string")
          .map(item => ({ event: item.event, properties: item.properties ?? {}, apiKey: body.api_key ?? null }));
      });
    },
    clear() { requests.length = 0; },
    close() { return new Promise(resolve => server.close(() => resolve())); },
  };
}
