// Closed diagnostics for the disposable hosted probe; never include response bodies or logs.
type ServedResponse = { status: number; data: Record<string, unknown> };
const statusConditions = new Map([
  [200, "http-200"],
  [400, "http-400"],
  [401, "http-401"],
  [403, "http-403"],
  [404, "http-404"],
  [405, "http-405"],
  [429, "http-429"],
  [500, "http-500"],
  [502, "http-502"],
  [503, "http-503"],
  [504, "http-504"],
]);
const statusCondition = (status: number) =>
  statusConditions.get(status) ?? "unexpected-http";

function requestCondition(error: unknown): string {
  if (error instanceof Error) {
    const protocol = /^access-served-(json|object):http-([0-9]{3})$/.exec(
      error.message,
    );
    if (protocol) {
      return `${statusCondition(Number(protocol[2]))}-${
        protocol[1] === "json" ? "non-json" : "non-object"
      }`;
    }
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "request-timeout";
    }
  }
  return "request-failed";
}

export async function pollServedAccess<T extends ServedResponse>(
  run: () => Promise<T>,
  accepted: (value: T) => boolean,
  phase: string | undefined,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const label = phase === "default" || phase === "synthetic"
    ? phase
    : "unknown";
  let condition = "request-failed";
  for (let i = 0; i < 25; i++) {
    try {
      const value = await run();
      if (accepted(value)) return value;
      condition = `${statusCondition(value.status)}-unexpected-envelope`;
    } catch (error) {
      condition = requestCondition(error);
    }
    await wait(400);
  }
  throw new Error(
    `access-cli-current-worker-readiness-failed:${label}:${condition}`,
  );
}
