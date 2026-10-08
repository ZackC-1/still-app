import { assertEquals, assertRejects } from "@std/assert";
import { readBoundedBody } from "./request-body.ts";

const req = (body?: BodyInit, headers?: HeadersInit) => new Request("https://audit.invalid", { method: "POST", body, headers });

Deno.test("bounded reader allows exact UTF-8 byte limit and releases its stream", async () => {
  const request = req("é");
  assertEquals(await readBoundedBody(request, { maxBytes: 2 }), "é");
  assertEquals(request.body!.locked, false);
  assertEquals(await readBoundedBody(req(), { maxBytes: 2 }), "");
});

Deno.test("body deadline is absolute even for a trickle and a stalled cancel", async () => {
  let interval: ReturnType<typeof setInterval>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { interval = setInterval(() => c.enqueue(new Uint8Array([32])), 5); },
    cancel() { cancelled = true; clearInterval(interval); return new Promise<void>(() => {}); },
  });
  try {
    await assertRejects(() => readBoundedBody(req(stream), { maxBytes: 1024, timeoutMs: 25 }), Error, "request-timeout");
    assertEquals(cancelled, true);
    assertEquals(stream.locked, false);
  } finally { clearInterval(interval!); }
});

Deno.test("oversized declared body is refused without awaiting cancel", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  await assertRejects(() => readBoundedBody(req(stream, { "content-length": "1025" }), { maxBytes: 1024 }), Error, "request-size");
  assertEquals(cancelled, true);
  assertEquals(stream.locked, false);
});

Deno.test("actual chunks override a false content-length declaration", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close();
  } });
  await assertRejects(() => readBoundedBody(req(stream, { "content-length": "1" }), { maxBytes: 1024 }), Error, "request-size");
  assertEquals(stream.locked, false);
});
