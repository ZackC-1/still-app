// The teardown generation — the shared torn-teardown guard for the two session
// orchestrators (apple-session, extension-session). A teardown (or identity switch)
// that lands while async work is in flight must invalidate that work: without the
// guard a stale reconcile or status write settles after the purge and resurrects
// signed-out state. The kernel owns only the counter; each host keeps its own gate
// conditions (Apple's publish serialization and session-identity checks, the
// extension's identity recheck and display guards) verbatim.

/** A captured generation snapshot. Opaque to callers: only hand it back to isCurrent. */
export type GenerationToken = number;

export interface TeardownGeneration {
  /** Mark a teardown: every token captured before this call goes stale. */
  bump(): void;
  /** Snapshot the current generation before an awaited span. */
  capture(): GenerationToken;
  /** True when no teardown happened since the token was captured. */
  isCurrent(token: GenerationToken): boolean;
}

export function createTeardownGeneration(): TeardownGeneration {
  let generation = 0;
  return {
    bump(): void {
      generation += 1;
    },
    capture(): GenerationToken {
      return generation;
    },
    isCurrent(token: GenerationToken): boolean {
      return token === generation;
    },
  };
}
