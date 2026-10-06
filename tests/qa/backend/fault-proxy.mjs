// A local fault-injecting reverse proxy in front of the QA stack's API (QA-P0 finding: BiDi network
// interception does not see a Firefox extension's own background requests). A build under test is
// configured with VITE_SUPABASE_URL = the proxy's URL; the proxy forwards everything to the local
// Supabase API unless a test sets a fault for matching requests:
//   { mode: "fail" }              the connection is dropped (a network error in the client)
//   { mode: "status", status }    an empty response with that status (e.g. 503)
//   { mode: "hold" }              the request waits until release() (states such as "checking")
// Faults match by method and path prefix, optionally only `times` times. Both ends are loopback only.
import { createServer, request as httpRequest } from "node:http";
import { assertLocalUrl } from "./guard.mjs";

export async function startFaultProxy({ upstream, port = 0 }) {
  const target = new URL(assertLocalUrl(upstream, "proxy upstream"));
  if (target.protocol !== "http:") throw new Error("the proxy forwards to the local http API only");
  let faults = [];
  const held = [];
  const seen = [];

  const match = req => {
    const fault = faults.find(f => (!f.method || f.method === req.method) && (req.url ?? "").startsWith(f.pathPrefix ?? "/"));
    if (!fault) return null;
    if (fault.times !== undefined && --fault.times <= 0) faults = faults.filter(f => f !== fault);
    return fault;
  };

  const forward = (req, res, body) => {
    const outgoing = httpRequest({
      host: target.hostname, port: target.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: target.host },
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    outgoing.end(body);
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, path: req.url });
      const fault = req.method === "OPTIONS" ? null : match(req);
      if (!fault) return forward(req, res, body);
      if (fault.mode === "fail") { req.socket.destroy(); return; }
      if (fault.mode === "status") {
        res.writeHead(fault.status ?? 503, { "access-control-allow-origin": "*" });
        res.end();
        return;
      }
      if (fault.mode === "hold") { held.push(() => forward(req, res, body)); return; }
      forward(req, res, body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: bound } = server.address();
  return {
    url: `http://127.0.0.1:${bound}`,
    /** Replace the fault list. */
    setFaults(next) {
      for (const f of next) {
        if (!["fail", "status", "hold"].includes(f.mode)) throw new Error(`unknown fault mode ${f.mode}`);
      }
      faults = next.map(f => ({ ...f }));
    },
    clearFaults() { faults = []; },
    /** Requests currently held. */
    get heldCount() { return held.length; },
    /** Let every held request continue to the upstream. */
    release() { for (const go of held.splice(0)) go(); },
    seen,
    close() {
      this.release();
      return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}
