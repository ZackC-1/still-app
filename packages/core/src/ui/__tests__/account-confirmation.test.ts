import { describe, expect, it, vi } from "vitest";
import { makeController } from "./support/controller-fixtures.js";

const account = { id: "account-a", email: "confirmed@example.test", emailConfirmed: true };

describe("account confirmation provenance", () => {
  it("does not infer confirmation from a display address or sync entitlement", async () => {
    const { c } = makeController({ auth: { signOut: async () => {} } });
    c.userId = account.id;
    c.accountEmail = account.email;
    c.entitled = true;
    await c.refreshAccountConfirmation();
    expect(c.accountConfirmed).toBe(false);
  });
  it("confirms only the current server-verified account", async () => {
    const read = vi.fn(async () => account);
    const { c } = makeController({ auth: { signOut: async () => {}, currentVerifiedAccount: read } });
    c.userId = account.id;
    await c.refreshAccountConfirmation();
    expect(c.accountConfirmed).toBe(true);
    c.accountRevision++;
    expect(c.accountConfirmed).toBe(false);
  });
  it("keeps unconfirmed email separate from verified authentication", async () => {
    const { c } = makeController({ auth: { signOut: async () => {}, currentVerifiedAccount: async () => ({ ...account, emailConfirmed: false }) } });
    c.userId = account.id;
    await c.refreshAccountConfirmation();
    expect(c.accountConfirmed).toBe(false);
  });
  it("rejects a response for another account", async () => {
    const { c } = makeController({ auth: { signOut: async () => {}, currentVerifiedAccount: async () => ({ ...account, id: "account-b" }) } });
    c.userId = account.id;
    await c.refreshAccountConfirmation();
    expect(c.accountConfirmed).toBe(false);
  });
  it("ignores a late response after account replacement", async () => {
    let complete!: (value: typeof account) => void;
    const pending = new Promise<typeof account>(resolve => { complete = resolve; });
    const { c } = makeController({ auth: { signOut: async () => {}, currentVerifiedAccount: () => pending } });
    c.userId = account.id;
    const read = c.refreshAccountConfirmation();
    c.userId = "account-b";
    c.accountRevision++;
    complete(account);
    await read;
    expect(c.accountConfirmed).toBe(false);
  });
  it("withdraws confirmation when fresh server verification fails", async () => {
    const read = vi.fn().mockResolvedValueOnce(account).mockRejectedValueOnce(new Error("offline"));
    const { c } = makeController({ auth: { signOut: async () => {}, currentVerifiedAccount: read } });
    c.userId = account.id;
    await c.refreshAccountConfirmation();
    expect(c.accountConfirmed).toBe(true);
    await c.refreshAccountConfirmation();
    expect(c.accountConfirmed).toBe(false);
    expect(c.userId).toBe(account.id);
  });
});

describe("overlapping confirmation reads", () => {
  it("cannot resurrect confirmation after a newer read rejects it", async () => {
    let complete!: (value: typeof account) => void;
    const old = new Promise<typeof account>(resolve => { complete = resolve; });
    const read = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce({ ...account, emailConfirmed: false });
    const { c } = makeController({ auth: { signOut: async () => {}, currentVerifiedAccount: read } });
    c.userId = account.id;
    const first = c.refreshAccountConfirmation();
    await c.refreshAccountConfirmation();
    complete(account);
    await first;
    expect(c.accountConfirmed).toBe(false);
  });
});
