import { assert, assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { createWriterSql } from "../../supabase/functions/_shared/pg-store.ts";

// A credential-free PostgreSQL wire fixture exercises the real driver's pool lifecycle.
// SQL semantics and narrow-role transactions remain covered by the disposable SQL rehearsal.
Deno.test("writer queues concurrent work on one connection, releases idle sockets, and reconnects", async () => {
  const sockets = new Set<Socket>();
  const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
  let peak = 0;
  let accepted = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    accepted++;
    peak = Math.max(peak, sockets.size);
    socket.on("close", () => sockets.delete(socket));
    let startup = true;
    let buffered = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= (startup ? 4 : 5)) {
        const length = buffered.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffered.length < length) return;
        const kind = buffered[0];
        buffered = buffered.subarray(length);
        if (startup) {
          startup = false;
          socket.write(Buffer.concat([Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]), ready]));
        } else if (kind === 88) socket.end(); // Terminate
        else {
          assertEquals(kind, 81); // Simple query
          // Hold the connection briefly so concurrent work cannot all reuse an idle socket.
          setTimeout(() => {
            if (!socket.destroyed) socket.write(Buffer.concat([
              Buffer.from([67, 0, 0, 0, 13]), Buffer.from("SELECT 0\0"), ready,
            ]));
          }, 50);
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const sql = createWriterSql(`postgres://synthetic:synthetic@127.0.0.1:${address.port}/synthetic?sslmode=disable`);
  sql.options.fetch_types = false; // Fixture has no type catalog.
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => sql.unsafe("select 1").simple()));
    assertEquals(results.length, 6);
    assertEquals(peak, 1, "parallel calls must share a bounded writer pool");
    const deadline = Date.now() + 25_000;
    while (sockets.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(sockets.size, 0, "idle connections must be released within 25 seconds");
    const before = accepted;
    await sql.unsafe("select 1").simple();
    assertEquals(accepted, before + 1, "the next request reconnects after idle release");
  } finally {
    await sql.end({ timeout: 1 });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
