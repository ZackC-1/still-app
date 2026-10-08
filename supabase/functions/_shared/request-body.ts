/** Bound transport input before parsing or privileged work. No request content is logged. */
export async function readBoundedBody(
  req: Request,
  { maxBytes, timeoutMs = 2000 }: { readonly maxBytes: number; readonly timeoutMs?: number },
): Promise<string> {
  if (req.signal.aborted) throw new Error("request-aborted");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    void req.body?.cancel().catch(() => {});
    throw new Error("request-size");
  }
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectRead!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectRead = reject; });
  const abort = () => rejectRead(new Error("request-aborted"));
  req.signal.addEventListener("abort", abort, { once: true });
  // One absolute deadline: sending another byte must not renew the request's budget.
  const timer = setTimeout(() => rejectRead(new Error("request-timeout")), timeoutMs);
  try {
    if (req.signal.aborted) throw new Error("request-aborted");
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("request-size");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
    // A producer may never acknowledge cancellation. Release the reader without waiting.
    try { void reader.cancel().catch(() => {}); }
    finally { reader.releaseLock(); }
  }
}
