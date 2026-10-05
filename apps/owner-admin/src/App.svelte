<script lang="ts">
  // The owner page. Signed out: email-code sign-in. Signed in: one authoritative read of both
  // policies, then the rating allowances and the sales switch. A 403 from the server at any point
  // shows the same neutral "Not available here" as an unconfigured page, and nothing else.
  import { AdminClient, type Environment, type PolicyState } from "./admin-client.js";
  import { applyChange, type Change, type FlowResult } from "./apply-flow.js";
  import type { OwnerAuth } from "./auth.js";
  import { APPROVED, PENDING_OWNER_COPY } from "./copy.js";
  import OwnerAllowances from "./OwnerAllowances.svelte";
  import {
    ratingDraft,
    ratingFromBody,
    salesDraft,
    salesFromBody,
    type RatingModel,
    type SalesModel,
  } from "./policy-model.js";
  import SalesSwitch from "./SalesSwitch.svelte";
  import { isBusy, type SectionState } from "./section-state.js";
  import SignIn from "./SignIn.svelte";

  let { auth, client }: { auth: OwnerAuth | null; client: AdminClient | null } = $props();

  type Phase = "unavailable" | "signed-out" | "loading" | "ready" | "load-failed";
  // svelte-ignore state_referenced_locally
  let phase = $state<Phase>(auth && client ? "signed-out" : "unavailable");
  let environment = $state<Environment>("sandbox");
  let rating = $state<{ state: PolicyState; model: RatingModel } | null>(null);
  let sales = $state<{ state: PolicyState; model: SalesModel } | null>(null);
  let ratingStatus = $state<SectionState>("idle");
  let salesStatus = $state<SectionState>("idle");
  let ratingView = $state<{ reset(): void } | undefined>();
  let salesView = $state<{ reset(): void } | undefined>();
  const busy = $derived(isBusy(ratingStatus) || isBusy(salesStatus));

  async function signOut() {
    await auth?.signOut();
    rating = null;
    sales = null;
    ratingStatus = "idle";
    salesStatus = "idle";
    phase = "signed-out";
  }

  function denied(kind: "forbidden" | "unauthorized") {
    if (kind === "forbidden") {
      rating = null;
      sales = null;
      phase = "unavailable";
    } else {
      void signOut();
    }
  }

  async function readRating(env: Environment) {
    const read = await client!.read("rating", env);
    if (read.kind !== "ok") return read.kind;
    const model = ratingFromBody(env, read.state.body, read.state.revision);
    return model ? { state: read.state, model } : "error";
  }
  async function readSales(env: Environment) {
    const read = await client!.read("sales", env);
    if (read.kind !== "ok") return read.kind;
    const model = salesFromBody(env, read.state.body, read.state.revision);
    return model ? { state: read.state, model } : "error";
  }

  async function load() {
    if (!client) return;
    phase = "loading";
    ratingStatus = "idle";
    salesStatus = "idle";
    const env = environment;
    const [r, s] = await Promise.all([readRating(env), readSales(env)]);
    if (env !== environment) return;
    if (r === "forbidden" || s === "forbidden") return denied("forbidden");
    if (r === "unauthorized" || s === "unauthorized") return denied("unauthorized");
    if (typeof r === "string" || typeof s === "string") {
      phase = "load-failed";
      return;
    }
    rating = r;
    sales = s;
    ratingView?.reset();
    salesView?.reset();
    phase = "ready";
  }

  /** Reload one section after a stale or unconfirmed result: the draft becomes the server state. */
  async function reloadSection(namespace: "rating" | "sales") {
    const result = namespace === "rating" ? await readRating(environment) : await readSales(environment);
    if (result === "forbidden" || result === "unauthorized") return denied(result);
    if (typeof result === "string") {
      phase = "load-failed";
      return;
    }
    if (namespace === "rating") {
      rating = result as { state: PolicyState; model: RatingModel };
      ratingView?.reset();
      ratingStatus = "idle";
    } else {
      sales = result as { state: PolicyState; model: SalesModel };
      salesView?.reset();
      salesStatus = "idle";
    }
  }

  /** The change each section last attempted (a draft or a rollback), so "Try again" after a
   * failure replays exactly that change and never a different one. */
  const lastChange: Record<"rating" | "sales", Change | null> = { rating: null, sales: null };

  async function run(namespace: "rating" | "sales", change: Change) {
    const loaded = namespace === "rating" ? rating : sales;
    if (!client || !loaded) return;
    lastChange[namespace] = change;
    const setStatus = (s: SectionState) => (namespace === "rating" ? (ratingStatus = s) : (salesStatus = s));
    const env = environment;
    const result: FlowResult = await applyChange(
      client,
      { namespace, environment: env, expectedRevision: loaded.state.revision },
      change,
      setStatus,
    );
    if (result.kind === "forbidden" || result.kind === "unauthorized") return denied(result.kind);
    if (result.kind !== "applied") return setStatus(result.kind);
    // Verified by readback: show the server's state as current, then say so.
    if (namespace === "rating") {
      const model = ratingFromBody(env, result.state.body, result.state.revision);
      if (!model) return setStatus("unconfirmed");
      rating = { state: result.state, model };
      ratingView?.reset();
    } else {
      const model = salesFromBody(env, result.state.body, result.state.revision);
      if (!model) return setStatus("unconfirmed");
      sales = { state: result.state, model };
      salesView?.reset();
    }
    setStatus("applied");
  }

  const applyRating = (draft: RatingModel) => run("rating", { draft: ratingDraft(draft) });
  const applySales = (draft: SalesModel) => run("sales", { draft: salesDraft(draft) });
  /** Try again after a failure: the same change again (it changed nothing, so it is still valid). */
  const retry = (namespace: "rating" | "sales") => {
    const change = lastChange[namespace];
    if (change) void run(namespace, change);
  };
  const rollback = (namespace: "rating" | "sales") => {
    const loaded = namespace === "rating" ? rating : sales;
    if (loaded && loaded.state.revision >= 2) void run(namespace, { rollbackOf: loaded.state.revision - 1 });
  };
</script>

<div class="owner-page">
  <header class="owner-header">
    <h1 class="wordmark">Still</h1>
    {#if phase !== "signed-out" && auth}
      <button type="button" class="link" onclick={signOut}>{APPROVED.signIn.signOut}</button>
    {/if}
  </header>

  {#if phase === "unavailable"}
    <section class="card card-stack"><p class="card-body">{APPROVED.unavailable}</p></section>
  {:else if phase === "signed-out" && auth}
    <SignIn {auth} onSignedIn={load} />
  {:else if phase === "loading"}
    <p class="muted" role="status">{APPROVED.loading}</p>
  {:else if phase === "load-failed"}
    <section class="card card-stack">
      <p class="error" role="alert">{PENDING_OWNER_COPY.loadFailed}</p>
      <button type="button" class="link" onclick={load}>{APPROVED.allowances.tryAgain}</button>
    </section>
  {:else if phase === "ready" && rating && sales}
    <div class="environment">
      <label class="field-label" for="owner-environment">{PENDING_OWNER_COPY.environmentLabel}</label>
      <select
        id="owner-environment"
        class="field"
        value={environment}
        disabled={busy}
        onchange={(event) => {
          environment = event.currentTarget.value === "production" ? "production" : "sandbox";
          void load();
        }}
      >
        <option value="sandbox">{PENDING_OWNER_COPY.environmentSandbox}</option>
        <option value="production">{PENDING_OWNER_COPY.environmentProduction}</option>
      </select>
    </div>
    <OwnerAllowances
      bind:this={ratingView}
      current={rating.model}
      revision={rating.state.revision}
      phase={ratingStatus}
      onApply={applyRating}
      onRollback={() => rollback("rating")}
      onEdit={() => (ratingStatus = "idle")}
      onStatusAction={(s) => (s === "failed" ? retry("rating") : reloadSection("rating"))}
    />
    <SalesSwitch
      bind:this={salesView}
      current={sales.model}
      revision={sales.state.revision}
      phase={salesStatus}
      onApply={applySales}
      onRollback={() => rollback("sales")}
      onEdit={() => (salesStatus = "idle")}
      onStatusAction={(s) => (s === "failed" ? retry("sales") : reloadSection("sales"))}
    />
  {/if}
</div>

<style>
  :global(html), :global(body) { margin: 0; background: var(--surface); color: var(--ink); }
  .owner-page {
    box-sizing: border-box;
    max-inline-size: var(--content-max-inline-size);
    margin-inline: auto;
    padding: var(--space-4) 16px var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .owner-header { display: flex; align-items: center; justify-content: space-between; }
  .wordmark { margin: 0; font-size: calc(20px * var(--text-scale, 1)); font-weight: 700; letter-spacing: -0.01em; }
  .environment { display: flex; flex-direction: column; gap: var(--space-2); }
</style>
