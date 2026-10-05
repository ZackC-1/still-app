// Apply, the only way the owner page changes anything: preview → apply → authoritative readback.
//
// The page reports success ONLY when its own fresh read of the server shows exactly the revision,
// body and operation it applied. An "applied" answer from the apply call is never shown as success
// by itself. When the outcome is uncertain the same operation is retried (the server makes that
// idempotent); after that, a fresh read decides what actually happened:
//   - the server matches the applied operation  → applied;
//   - the server is still at the loaded revision → failed, and nothing changed (true by the read);
//   - the server moved on to someone else's revision → stale;
//   - the read itself fails → unconfirmed (the page never guesses either way).
import type { AdminClient, Environment, Namespace, PolicyState, Preview } from "./admin-client.js";

export type Progress = "applying" | "readback";
export type FlowResult =
  | { readonly kind: "applied"; readonly state: PolicyState }
  | { readonly kind: "stale" }
  | { readonly kind: "failed"; readonly state?: PolicyState }
  /** The server refused to turn sales on before the paid cutoff exists. Nothing changed. */
  | { readonly kind: "cutoff-refused" }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unauthorized" };

export type Change =
  | { readonly draft: unknown }
  | { readonly rollbackOf: number };

/** Same-operation retries after a "checking" or transport failure, before the deciding read. */
export const APPLY_ATTEMPTS = 3;

export async function applyChange(
  client: AdminClient,
  target: { namespace: Namespace; environment: Environment; expectedRevision: number },
  change: Change,
  onProgress: (progress: Progress) => void = () => {},
): Promise<FlowResult> {
  const { namespace, environment, expectedRevision } = target;
  onProgress("applying");
  const staged = "draft" in change
    ? await client.preview(namespace, environment, expectedRevision, change.draft)
    : await client.previewRollback(namespace, environment, expectedRevision, change.rollbackOf);
  if (staged.kind === "forbidden" || staged.kind === "unauthorized" || staged.kind === "stale") return { kind: staged.kind };
  // A preview writes no policy, so any other failure here really changed nothing.
  if (staged.kind !== "previewed") return { kind: "failed" };
  const preview: Preview = staged;

  for (let attempt = 0; attempt < APPLY_ATTEMPTS; attempt++) {
    const applied = await client.apply(namespace, environment, preview);
    if (applied.kind === "forbidden" || applied.kind === "unauthorized" || applied.kind === "stale") return { kind: applied.kind };
    if (applied.kind === "refused") {
      return applied.reason === "cutoff_required" ? { kind: "cutoff-refused" } : { kind: "failed" };
    }
    if (applied.kind === "applied") break;
    // "checking" or a transport/server error: the commit may or may not have happened.
  }

  onProgress("readback");
  const read = await client.read(namespace, environment);
  if (read.kind === "forbidden" || read.kind === "unauthorized") return { kind: read.kind };
  if (read.kind !== "ok") return { kind: "unconfirmed" };
  const state = read.state;
  if (state.revision === preview.revision && state.body === preview.body && state.operationId === preview.operationId) {
    return { kind: "applied", state };
  }
  if (state.revision === expectedRevision) return { kind: "failed", state };
  return { kind: "stale" };
}
