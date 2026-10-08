// Diagnostic-only public CLI v2.119.0 worker/log categories. Never emit log text.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DIAGNOSTIC_BYTE_LIMIT = 65_536;
export function classifyAccessCliFailure(text, phase) {
  const label = phase === "default" || phase === "synthetic"
    ? phase
    : "unknown";
  const rules = [
    [
      "boot",
      /worker boot|failed to create worker|failed to bootstrap runtime|InvalidWorkerCreation/i,
    ],
    [
      "import-resolution",
      /module not found|failed to resolve|not in import map|does not provide an export/i,
    ],
    [
      "mount",
      /failed to read (?:path|file)|no such file or directory|os error 2|read-only file system/i,
    ],
    [
      "npm",
      /could not find npm package|npm package.*not found|failed to (?:load|resolve|download) npm/i,
    ],
    ["privilege", /42501|28P01|rate limiter unavailable/i],
  ];
  return {
    accessCliFailure: {
      phase: label,
      categories: rules.filter(([, expression]) => expression.test(text)).map((
        [name],
      ) => name),
    },
  };
}

export function readDiagnosticTail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, DIAGNOSTIC_BYTE_LIMIT));
    const count = readSync(
      fd,
      buffer,
      0,
      buffer.length,
      Math.max(0, size - buffer.length),
    );
    return buffer.subarray(0, count).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function collectDiagnosticTail(stream) {
  let tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    tail = bytes.length >= DIAGNOSTIC_BYTE_LIMIT
      ? Buffer.from(bytes.subarray(-DIAGNOSTIC_BYTE_LIMIT))
      : Buffer.concat([
        tail.subarray(
          Math.max(0, tail.length + bytes.length - DIAGNOSTIC_BYTE_LIMIT),
        ),
        bytes,
      ]);
  }
  return tail.toString("utf8");
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let edgeText = "";
  try {
    edgeText = await collectDiagnosticTail(process.stdin);
  } catch {}
  console.log(JSON.stringify(classifyAccessCliFailure(
    `${readDiagnosticTail(process.argv[2])}\n${edgeText}`,
    process.argv[3],
  )));
}
