import type { AnalyticsClient, AnalyticsConfig } from "./client.js";
import { originProof } from "./derive.js";

export interface PurchaseAnalyticsContext {
  readonly account: string;
  readonly body: {
    readonly originProof: string;
    readonly projectKeySha256: string;
  };
  readonly signal: AbortSignal;
  /** Synchronous last fence: call immediately before dispatch, without another await. */
  current(): boolean;
}
/** Captures only an already-confirmed signed-in subject. No new identity, permission or history
 * is created here. A device's origin never leaves this function; its proof cannot erase it. */
export function purchaseAnalyticsContext(
  client: AnalyticsClient,
  config: AnalyticsConfig,
  channel?: "release" | "dev" | "test",
) {
  let digest: Promise<string> | undefined;
  return async (): Promise<PurchaseAnalyticsContext | null> => {
    if (
      !client.enabled ||
      !client.accountConfirmed ||
      !config.key?.trim() ||
      channel === "test" ||
      channel === "dev"
    )
      return null;
    const observation = await client.captureObservation();
    if (!observation) return null;
    const account = await client.accountInForce();
    const subject = await client.signedInAs();
    if (
      !account ||
      !subject ||
      subject === account ||
      !(await client.canReport())
    )
      return null;
    const [proof, project] = await Promise.all([
      originProof(observation.permission.origin),
      (digest ??= crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(config.key.trim()))
        .then((value) =>
          [...new Uint8Array(value)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        )),
    ]);
    if (
      (await client.accountInForce()) !== account ||
      !(await client.observationCurrent(observation))
    )
      return null;
    const signal = client.cancellationSignal();
    const current = () =>
      client.accountConfirmed &&
      client.isCurrent(observation.stamp) &&
      !signal.aborted;
    return current()
      ? {
          account,
          body: { originProof: proof, projectKeySha256: project },
          signal,
          current,
        }
      : null;
  };
}

/** Final fetch adapter runs after the SDK has acquired its authorization header. The optional
 * context is bounded and never delays/refuses functional checkout indefinitely. Account comparison
 * merely binds local analytics scope; hosted JWT verification remains the authentication boundary. */
export function withCheckoutAnalytics(
  fetchImpl: typeof fetch,
  checkoutUrl: string,
  capture: () => Promise<PurchaseAnalyticsContext | null>,
): typeof fetch {
  return async (input, init) => {
    if (
      typeof input !== "string" ||
      input !== checkoutUrl ||
      init?.method !== "POST" ||
      typeof init.body !== "string"
    )
      return fetchImpl(input, init);
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(init.body);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as Record<string, unknown>).access_schema !== 1
      )
        return fetchImpl(input, init);
      body = { ...value };
    } catch {
      return fetchImpl(input, init);
    }
    // Every actual dispatch obtains fresh authority, including SDK retries. No cached optional body.
    delete body.analytics;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context = await Promise.race([
        Promise.resolve()
          .then(capture)
          .catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 250);
        }),
      ]);
      const authorization = new Headers(init.headers).get("Authorization");
      let account: unknown;
      try {
        const segment = authorization?.replace(/^Bearer /, "").split(".")[1];
        if (segment && segment.length <= 8192)
          account = JSON.parse(
            atob(segment.replace(/-/g, "+").replace(/_/g, "/")),
          ).sub;
      } catch {
        /* Unreadable authorization cannot carry attribution. The server decides payment. */
      }
      if (context && account === context.account && context.current())
        body.analytics = context.body;
    } finally {
      clearTimeout(timer);
    }
    return fetchImpl(input, { ...init, body: JSON.stringify(body) });
  };
}

export interface PurchaseAnalyticsReporterDeps {
  capture(): Promise<PurchaseAnalyticsContext | null>;
  /** Prepare Auth first; the final permission read and dispatch follow it. */
  prepare(): Promise<{
    account: string;
    send(
      body: PurchaseAnalyticsContext["body"],
      signal: AbortSignal,
    ): Promise<unknown>;
  } | null>;
  now?: () => number;
}
/** Trigger only from an ordinary Still screen. At most one call per 30 seconds, no retries/timer
 * or retained work; the next screen can ask again with its own fresh permission. */
export function purchaseAnalyticsReporter(
  deps: PurchaseAnalyticsReporterDeps,
): () => void {
  let inFlight = false;
  let next = 0;
  const now = deps.now ?? Date.now;
  return () => {
    if (inFlight || now() < next) return;
    inFlight = true;
    next = now() + 30_000;
    void (async () => {
      const prepared = await deps.prepare();
      if (!prepared) return;
      const context = await deps.capture();
      if (
        !context ||
        prepared.account !== context.account ||
        !context.current()
      )
        return;
      await prepared.send(context.body, context.signal);
    })()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
}
