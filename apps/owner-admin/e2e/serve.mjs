// A minimal static server for the smoke test: serves the built page and nothing else. The
// Supabase endpoints on the same origin are answered by the test's routes, never by this server.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(resolve(import.meta.dirname, "dist/index.html"));
const port = Number(process.env.PORT ?? 4317);
createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(port, "127.0.0.1");
