import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import { AdminClient } from "./admin-client.js";
import App from "./App.svelte";
import type { OwnerAuth } from "./auth.js";
import { APPROVED, PENDING_OWNER_COPY } from "./copy.js";
import { allSurfaces, FakeAdminFunction, OWNER_TOKEN, salesChannels, STRANGER_TOKEN } from "./test-support/fake-admin.js";

const A = APPROVED.allowances;
const BUILDS = [
  { surface: "chrome_desktop", build: "chrome-3.0.0" },
  { surface: "firefox_desktop", build: "firefox-3.0.0" },
];

function fakeAuth(sessionToken: string) {
  let token: string | null = null;
  const auth: OwnerAuth = {
    requestCode: async () => "sent",
    verifyCode: async (_email, code) => {
      if (code !== "123456") return "wrong-code";
      token = sessionToken;
      return "verified";
    },
    accessToken: async () => token,
    signOut: async () => {
      token = null;
    },
  };
  return { auth, token: () => token };
}

async function signIn(sessionToken = OWNER_TOKEN, server = new FakeAdminFunction()) {
  const { auth, token } = fakeAuth(sessionToken);
  const client = new AdminClient(server.transport(token));
  const view = render(App, { auth, client });
  await fireEvent.input(screen.getByLabelText(APPROVED.signIn.emailLabel), { target: { value: "person@example.com" } });
  await fireEvent.click(screen.getByRole("button", { name: APPROVED.signIn.send }));
  await fireEvent.input(await screen.findByLabelText(APPROVED.signIn.codeLabel), { target: { value: "123456" } });
  await fireEvent.click(screen.getByRole("button", { name: APPROVED.signIn.verify }));
  return { server, view };
}

const allowances = () => screen.getByRole("region", { name: A.title });
const sales = () => screen.getByRole("region", { name: PENDING_OWNER_COPY.salesTitle });
const switchFor = (region: HTMLElement, name: string) => within(region).getByRole("switch", { name });

describe("owner page", () => {
  it("unconfigured: shows only the neutral unavailable state", () => {
    render(App, { auth: null, client: null });
    expect(screen.getByText(APPROVED.unavailable)).toBeInTheDocument();
    expect(screen.queryByLabelText(APPROVED.signIn.emailLabel)).toBeNull();
  });

  it("a signed-in non-owner (403) sees 'Not available here' and nothing about who the owner is", async () => {
    const server = new FakeAdminFunction();
    server.seed("rating", "sandbox", { master: true, surfaces: allSurfaces(true), builds: BUILDS });
    await signIn(STRANGER_TOKEN, server);
    expect(await screen.findByText(APPROVED.unavailable)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/owner|allowlist|admin|forbidden|403/i);
    expect(screen.queryByRole("region", { name: A.title })).toBeNull();
    expect(screen.getByRole("button", { name: APPROVED.signIn.signOut })).toBeInTheDocument();
  });

  it("shows the D28 allowances with the approved copy, everything Off, Edge Deferred and Apply disabled", async () => {
    await signIn();
    const region = await screen.findByRole("region", { name: A.title });
    expect(within(region).getByRole("heading", { name: A.title })).toBeInTheDocument();
    expect(within(region).getByText(A.body)).toBeInTheDocument();
    expect(within(region).getByText(A.deferred)).toBeInTheDocument();
    expect(within(region).queryByRole("switch", { name: APPROVED.surfaces.edge_desktop })).toBeNull();
    for (const name of [A.all, "Chrome desktop", "Firefox desktop", "Firefox Android", "Apple mobile host", "Apple macOS host"]) {
      expect(switchFor(region, name)).toHaveAttribute("aria-checked", "false");
    }
    expect(within(region).getByRole("button", { name: A.apply })).toBeDisabled();
    expect(region.textContent).toContain(`${A.previewLead}${A.previewNone}.`);
  });

  it("applies, shows the readback line while reading back, and only then 'Applied and read back'", async () => {
    const server = new FakeAdminFunction();
    server.seed("rating", "sandbox", { master: false, surfaces: allSurfaces(false), builds: BUILDS });
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    await fireEvent.click(switchFor(region, A.all));
    await fireEvent.click(switchFor(region, "Chrome desktop"));
    expect(within(region).getAllByText(A.changed)).toHaveLength(2);
    expect(region.textContent).toContain(`${A.previewLead}Chrome desktop.`);

    let release!: () => void;
    server.readGate = new Promise<void>((resolve) => (release = resolve));
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await within(region).findByText(A.readback)).toBeInTheDocument();
    // Accepted by apply, but not read back yet: no success, controls locked.
    expect(within(region).queryByText(A.applied)).toBeNull();
    expect(within(region).getByRole("button", { name: A.apply })).toBeDisabled();
    expect(switchFor(region, "Chrome desktop")).toHaveAttribute("aria-disabled", "true");

    server.readGate = null;
    release();
    expect(await within(region).findByText(A.applied)).toBeInTheDocument();
    expect(within(region).queryByText(A.changed)).toBeNull();
    expect(switchFor(region, "Chrome desktop")).toHaveAttribute("aria-checked", "true");
    expect(server.current("rating", "sandbox")!.revision).toBe(2);
  });

  it("never shows success when the readback disagrees with apply", async () => {
    const server = new FakeAdminFunction();
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    await fireEvent.click(switchFor(region, A.all));
    server.lieApplied = true;
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await within(region).findByText(A.failed)).toBeInTheDocument();
    expect(within(region).queryByText(A.applied)).toBeNull();
  });

  it("master Off keeps the surface choices", async () => {
    const server = new FakeAdminFunction();
    server.seed("rating", "sandbox", { master: true, surfaces: { ...allSurfaces(false), chrome_desktop: true }, builds: BUILDS });
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    await fireEvent.click(switchFor(region, A.all));
    expect(switchFor(region, A.all)).toHaveAttribute("aria-checked", "false");
    expect(switchFor(region, "Chrome desktop")).toHaveAttribute("aria-checked", "true");
    expect(region.textContent).toContain(`${A.previewLead}${A.previewNone}.`);
    await fireEvent.click(within(region).getByRole("button", { name: A.discard }));
    expect(switchFor(region, A.all)).toHaveAttribute("aria-checked", "true");
  });

  it("stale: says so and Reload brings in the current server state", async () => {
    const server = new FakeAdminFunction();
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    await fireEvent.click(switchFor(region, A.all));
    server.seed("rating", "sandbox", { master: true, surfaces: { ...allSurfaces(false), firefox_desktop: true }, builds: BUILDS });
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await within(region).findByText(A.stale)).toBeInTheDocument();
    await fireEvent.click(within(region).getByRole("button", { name: A.reload }));
    await waitFor(() => expect(switchFor(region, "Firefox desktop")).toHaveAttribute("aria-checked", "true"));
    expect(within(region).queryByText(A.stale)).toBeNull();
    expect(server.writes).toBe(1); // only the other change
  });

  it("failure: 'Apply didn't finish. Nothing changed.' and Try again applies the same draft", async () => {
    const server = new FakeAdminFunction();
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    await fireEvent.click(switchFor(region, A.all));
    server.failApply = true;
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await within(region).findByText(A.failed)).toBeInTheDocument();
    expect(server.writes).toBe(0);
    server.failApply = false;
    await fireEvent.click(within(region).getByRole("button", { name: A.tryAgain }));
    expect(await within(region).findByText(A.applied)).toBeInTheDocument();
    expect(server.writes).toBe(1);
  });

  it("Try again after a failed Undo repeats the Undo, not the unchanged draft (allowances)", async () => {
    const server = new FakeAdminFunction();
    server.seed("rating", "sandbox", { master: false, surfaces: allSurfaces(false), builds: BUILDS });
    server.seed("rating", "sandbox", { master: true, surfaces: allSurfaces(true), builds: BUILDS });
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    expect(switchFor(region, A.all)).toHaveAttribute("aria-checked", "true");
    server.failApply = true;
    await fireEvent.click(within(region).getByRole("button", { name: PENDING_OWNER_COPY.rollback }));
    expect(await within(region).findByText(A.failed)).toBeInTheDocument();
    expect(server.writes).toBe(2);
    server.failApply = false;
    await fireEvent.click(within(region).getByRole("button", { name: A.tryAgain }));
    expect(await within(region).findByText(A.applied)).toBeInTheDocument();
    const previews = server.calls.filter((c) => String(c.action).startsWith("preview"));
    expect(previews.at(-1)).toMatchObject({ action: "preview-rollback", sourceRevision: 1, expectedRevision: 2 });
    expect(JSON.parse(server.current("rating", "sandbox")!.body)).toMatchObject({ revision: 3, master: false });
    expect(switchFor(region, A.all)).toHaveAttribute("aria-checked", "false");
  });

  it("Try again after a failed Undo repeats the Undo, not the unchanged draft (sales)", async () => {
    const server = new FakeAdminFunction();
    server.seed("sales", "sandbox", { salesEnabled: false, channels: salesChannels(false), builds: [] });
    server.seed("sales", "sandbox", { salesEnabled: true, channels: salesChannels(true), builds: [] });
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: PENDING_OWNER_COPY.salesTitle });
    expect(switchFor(region, PENDING_OWNER_COPY.salesSwitch)).toHaveAttribute("aria-checked", "true");
    server.failApply = true;
    await fireEvent.click(within(region).getByRole("button", { name: PENDING_OWNER_COPY.rollback }));
    expect(await within(region).findByText(A.failed)).toBeInTheDocument();
    server.failApply = false;
    await fireEvent.click(within(region).getByRole("button", { name: A.tryAgain }));
    expect(await within(region).findByText(A.applied)).toBeInTheDocument();
    const previews = server.calls.filter((c) => c.namespace === "sales" && String(c.action).startsWith("preview"));
    expect(previews.at(-1)).toMatchObject({ action: "preview-rollback", sourceRevision: 1, expectedRevision: 2 });
    expect(JSON.parse(server.current("sales", "sandbox")!.body)).toMatchObject({ revision: 3, salesEnabled: false });
    expect(switchFor(region, PENDING_OWNER_COPY.salesSwitch)).toHaveAttribute("aria-checked", "false");
  });

  it("says plainly that switching on does nothing while no approved builds are listed", async () => {
    await signIn(); // nothing on record: no builds in either policy
    const rating = await screen.findByRole("region", { name: A.title });
    expect(within(rating).getByText(PENDING_OWNER_COPY.noBuilds)).toBeInTheDocument();
    expect(within(sales()).getByText(PENDING_OWNER_COPY.noBuilds)).toBeInTheDocument();
  });

  it("drops that line in a section once its policy lists approved builds", async () => {
    const server = new FakeAdminFunction();
    server.seed("rating", "sandbox", { master: false, surfaces: allSurfaces(false), builds: BUILDS });
    await signIn(OWNER_TOKEN, server);
    const rating = await screen.findByRole("region", { name: A.title });
    expect(within(rating).queryByText(PENDING_OWNER_COPY.noBuilds)).toBeNull();
    expect(within(sales()).getByText(PENDING_OWNER_COPY.noBuilds)).toBeInTheDocument();
  });

  it("sales switched on with no approved builds applies and reads back, and still says it has no effect", async () => {
    const server = new FakeAdminFunction();
    server.seed("sales", "sandbox", { salesEnabled: false, channels: salesChannels(false), builds: [] });
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: PENDING_OWNER_COPY.salesTitle });
    expect(within(region).getByText(PENDING_OWNER_COPY.noBuilds)).toBeInTheDocument();
    await fireEvent.click(switchFor(region, PENDING_OWNER_COPY.salesSwitch));
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await within(region).findByText(A.applied)).toBeInTheDocument();
    // Nothing activates without a listed build, so the server has no cutoff to refuse.
    expect(within(region).queryByText(PENDING_OWNER_COPY.salesCutoffRefused)).toBeNull();
    expect(JSON.parse(server.current("sales", "sandbox")!.body)).toMatchObject({ revision: 2, salesEnabled: true, builds: [] });
    expect(switchFor(region, PENDING_OWNER_COPY.salesSwitch)).toHaveAttribute("aria-checked", "true");
    expect(within(region).getByText(PENDING_OWNER_COPY.noBuilds)).toBeInTheDocument();
  });

  it("losing owner access mid-session (403 on apply) switches to the neutral state", async () => {
    const server = new FakeAdminFunction();
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: A.title });
    await fireEvent.click(switchFor(region, A.all));
    server.owners.delete(OWNER_TOKEN);
    server.signedIn.set(OWNER_TOKEN, "00000000-0000-4000-8000-000000000001");
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await screen.findByText(APPROVED.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: A.title })).toBeNull();
  });

  it("sales: the server's refusal before the paid cutoff is shown and nothing changes", async () => {
    const server = new FakeAdminFunction();
    server.seed("sales", "sandbox", { salesEnabled: false, channels: salesChannels(false), builds: BUILDS });
    await signIn(OWNER_TOKEN, server);
    const region = await screen.findByRole("region", { name: PENDING_OWNER_COPY.salesTitle });
    await fireEvent.click(switchFor(region, PENDING_OWNER_COPY.salesSwitch));
    await fireEvent.click(within(region).getByRole("button", { name: A.apply }));
    expect(await within(region).findByText(PENDING_OWNER_COPY.salesCutoffRefused)).toBeInTheDocument();
    expect(within(region).queryByText(A.applied)).toBeNull();
    expect(server.current("sales", "sandbox")!.revision).toBe(1);
    expect(sales()).toBeInTheDocument();
  });

  it("the environment picker reads the other environment's state", async () => {
    const server = new FakeAdminFunction();
    server.seed("rating", "production", { master: true, surfaces: allSurfaces(false), builds: BUILDS });
    await signIn(OWNER_TOKEN, server);
    await screen.findByRole("region", { name: A.title });
    expect(switchFor(allowances(), A.all)).toHaveAttribute("aria-checked", "false");
    await fireEvent.change(screen.getByLabelText(PENDING_OWNER_COPY.environmentLabel), { target: { value: "production" } });
    await waitFor(() => expect(switchFor(allowances(), A.all)).toHaveAttribute("aria-checked", "true"));
  });

  it("a wrong code keeps the person on the code step with the shipped message", async () => {
    const { auth, token } = fakeAuth(OWNER_TOKEN);
    render(App, { auth, client: new AdminClient(new FakeAdminFunction().transport(token)) });
    await fireEvent.input(screen.getByLabelText(APPROVED.signIn.emailLabel), { target: { value: "person@example.com" } });
    await fireEvent.click(screen.getByRole("button", { name: APPROVED.signIn.send }));
    await fireEvent.input(await screen.findByLabelText(APPROVED.signIn.codeLabel), { target: { value: "000000" } });
    await fireEvent.click(screen.getByRole("button", { name: APPROVED.signIn.verify }));
    expect(await screen.findByText(APPROVED.signIn.wrongCode)).toBeInTheDocument();
  });
});
