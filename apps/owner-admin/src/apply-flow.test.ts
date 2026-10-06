import { describe, expect, it } from "vitest";
import { AdminClient } from "./admin-client.js";
import { applyChange, APPLY_ATTEMPTS, type Progress } from "./apply-flow.js";
import { ratingDraft, ratingFromBody, RATING_OFF, salesDraft, SALES_OFF } from "./policy-model.js";
import { allSurfaces, FakeAdminFunction, OWNER_TOKEN, STRANGER_TOKEN } from "./test-support/fake-admin.js";

const CHROME_BUILD = { surface: "chrome_desktop" as const, build: "chrome-3.0.0" };

function setup(token = OWNER_TOKEN) {
  const server = new FakeAdminFunction();
  const client = new AdminClient(server.transport(() => token));
  return { server, client };
}

const target = (expectedRevision = 0) => ({ namespace: "rating" as const, environment: "sandbox" as const, expectedRevision });
const ratingOn = ratingDraft({ ...RATING_OFF, master: true, surfaces: { ...RATING_OFF.surfaces, chrome_desktop: true } });

describe("applyChange: preview → apply → authoritative readback", () => {
  it("reports applied only after its own read shows the applied operation", async () => {
    const { server, client } = setup();
    const progress: Progress[] = [];
    const result = await applyChange(client, target(), { draft: ratingOn }, (p) => progress.push(p));

    expect(server.calls.map((c) => c.action)).toEqual(["preview", "apply", "read"]);
    expect(progress).toEqual(["applying", "readback"]);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    const stored = server.current("rating", "sandbox")!;
    expect(result.state).toMatchObject({ revision: 1, body: stored.body, operationId: stored.operationId });
    expect(ratingFromBody("sandbox", result.state.body, 1)).toMatchObject({ master: true });
  });

  it("does not report success when apply says applied but the readback disagrees", async () => {
    const { server, client } = setup();
    server.lieApplied = true; // claims success, writes nothing
    const result = await applyChange(client, target(), { draft: ratingOn });
    expect(result.kind).not.toBe("applied");
    // The read proves the server never moved: nothing changed is the honest answer.
    expect(result).toMatchObject({ kind: "failed", state: { revision: 0 } });
    expect(server.writes).toBe(0);
  });

  it("returns stale when someone else applied first, and writes nothing of ours", async () => {
    const { server, client } = setup();
    server.raceNextApply = true;
    const result = await applyChange(client, target(), { draft: ratingOn });
    expect(result.kind).toBe("stale");
    expect(server.current("rating", "sandbox")!.revision).toBe(1); // only the other change
  });

  it("returns stale at preview when the loaded revision is old", async () => {
    const { server, client } = setup();
    server.seed("rating", "sandbox", { ...RATING_OFF, builds: [] });
    const result = await applyChange(client, target(0), { draft: ratingOn });
    expect(result.kind).toBe("stale");
    expect(server.calls.map((c) => c.action)).toEqual(["preview"]);
  });

  it("a failed apply changes nothing and says so only after the read proves it", async () => {
    const { server, client } = setup();
    server.failApply = true;
    const progress: Progress[] = [];
    const result = await applyChange(client, target(), { draft: ratingOn }, (p) => progress.push(p));
    expect(result).toMatchObject({ kind: "failed", state: { revision: 0 } });
    expect(server.calls.filter((c) => c.action === "apply")).toHaveLength(APPLY_ATTEMPTS);
    expect(progress.at(-1)).toBe("readback");
    expect(server.writes).toBe(0);
  });

  it("an invalid draft fails at preview with nothing written", async () => {
    const { server, client } = setup();
    const result = await applyChange(client, target(), { draft: { ...ratingOn, reviewUrl: "https://example.invalid" } });
    expect(result.kind).toBe("failed");
    expect(server.writes).toBe(0);
  });

  it("a signed-in non-owner gets forbidden and nothing is staged", async () => {
    const { server, client } = setup(STRANGER_TOKEN);
    const result = await applyChange(client, target(), { draft: ratingOn });
    expect(result.kind).toBe("forbidden");
    expect(server.operations.size).toBe(0);
  });

  it("no session is unauthorized", async () => {
    const server = new FakeAdminFunction();
    const client = new AdminClient(server.transport(() => null));
    expect((await applyChange(client, target(), { draft: ratingOn })).kind).toBe("unauthorized");
  });

  it("'checking' retries the same operation, which commits exactly once", async () => {
    const { server, client } = setup();
    server.afterCommit = "checking";
    const result = await applyChange(client, target(), { draft: ratingOn });
    expect(result.kind).toBe("applied");
    const applies = server.calls.filter((c) => c.action === "apply");
    expect(applies).toHaveLength(2);
    expect(applies[0]).toEqual(applies[1]); // identical retry, never a new preview
    expect(server.writes).toBe(1);
  });

  it("a lost reply after commit is settled by the readback, not guessed", async () => {
    const { server, client } = setup();
    server.afterCommit = "drop";
    server.afterCommitTimes = APPLY_ATTEMPTS; // every apply reply is lost
    const result = await applyChange(client, target(), { draft: ratingOn });
    expect(result.kind).toBe("applied");
    expect(server.writes).toBe(1);
  });

  it("an unreadable readback is unconfirmed, never success or 'nothing changed'", async () => {
    const { server, client } = setup();
    server.failReads = 1;
    const result = await applyChange(client, target(), { draft: ratingOn });
    expect(result.kind).toBe("unconfirmed");
    expect(server.writes).toBe(1);
  });

  it("the server's refusal to turn sales on before the cutoff is reported, and nothing changes", async () => {
    const { server, client } = setup();
    const draft = salesDraft({ ...SALES_OFF, on: true, builds: [CHROME_BUILD] });
    const result = await applyChange(client, { namespace: "sales", environment: "sandbox", expectedRevision: 0 }, { draft });
    expect(result.kind).toBe("cutoff-refused");
    expect(server.writes).toBe(0);
  });

  it("rollback republishes the previous revision's values at a new revision", async () => {
    const { server, client } = setup();
    server.seed("rating", "sandbox", { master: false, surfaces: allSurfaces(false), builds: [CHROME_BUILD] });
    server.seed("rating", "sandbox", { master: true, surfaces: allSurfaces(true), builds: [CHROME_BUILD] });
    const result = await applyChange(client, target(2), { rollbackOf: 1 });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.state.revision).toBe(3);
    expect(ratingFromBody("sandbox", result.state.body, 3)).toMatchObject({ master: false });
  });
});
