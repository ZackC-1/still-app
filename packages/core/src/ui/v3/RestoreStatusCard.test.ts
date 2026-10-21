import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tick } from "svelte";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/svelte";
import RestoreStatusCard from "./RestoreStatusCard.svelte";

const BROWSER_NOTHING = [
  "No Still Pro purchase was found for this account.",
  "Bought it with another account or Apple ID? Sign in with that one and try again.",
];
// Owner decision 26 (the Apple app passes this as its override).
const APPLE_NOTHING = [
  "No Still Pro purchase was found for this Apple Account.",
  "Bought it with another Apple Account? Sign in with that one and try again.",
];

const COPY = { text: APPLE_NOTHING[0]!, detail: APPLE_NOTHING[1]! };

afterEach(cleanup);

function lines(view: { container: HTMLElement }): string[] {
  const body = view.container.querySelector(".status-body")!;
  return [...body.children].map((child) => child.textContent ?? "");
}

describe("RestoreStatusCard nothing-found wording", () => {
  it("browser hosts keep their wording", () => {
    expect(lines(render(RestoreStatusCard, { props: { state: "nothing" } }))).toEqual(BROWSER_NOTHING);
    cleanup();
    expect(
      lines(render(RestoreStatusCard, { props: { state: "nothing", nothingCopy: undefined } })),
    ).toEqual(BROWSER_NOTHING);
  });

  it("a supplied nothing wording replaces only the text and detail", () => {
    const view = render(RestoreStatusCard, { props: { state: "nothing", nothingCopy: COPY } });
    expect(lines(view)).toEqual(APPLE_NOTHING);
    expect(view.container.querySelector(".status-line")).toHaveAttribute("role", "status");
    expect(view.container.querySelector("button")).toBeNull();
  });

  it.each(["checking", "restored", "failed", "verify"] as const)(
    "the override changes no other state (%s)",
    (state) => {
      const browser = lines(render(RestoreStatusCard, { props: { state } }));
      cleanup();
      expect(lines(render(RestoreStatusCard, { props: { state, nothingCopy: COPY } }))).toEqual(browser);
    },
  );
});

describe("RestoreStatusCard verify-again wording (owner, ISS-0029 item 6)", () => {
  it("shows only the one line and its Verify now action", () => {
    const view = render(RestoreStatusCard, { props: { state: "verify" } });
    expect(lines(view)).toEqual(["Still Pro needs to be verified again.", "Verify now"]);
    expect(view.container.textContent).not.toContain("Go online and sign in");
  });
});

// ISS-0117: on the Chrome/Firefox settings page the result of a Restore check rendered below the
// visible area, so "Checking…" seemed to end in nothing. When a check concludes, the card brings
// its result into view (only if it is not already fully visible) and takes keyboard focus.
describe("RestoreStatusCard brings a concluded check into view (ISS-0117)", () => {
  type CardState = "checking" | "restored" | "nothing" | "failed" | "verify";
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  let scrolled: Element[] = [];
  let below = true;

  beforeEach(() => {
    scrolled = [];
    below = true;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: Element, options?: ScrollIntoViewOptions) {
        expect(options).toEqual({ block: "nearest" });
        scrolled.push(this);
      }),
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = below && this.classList.contains("status-line") ? window.innerHeight + 200 : 100;
      return { top, bottom: top + 60, left: 0, right: 300, width: 300, height: 60, x: 0, y: top, toJSON() {} } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  async function conclude(state: CardState) {
    const view = render(RestoreStatusCard, { props: { state: "checking" as CardState } });
    const line = view.container.querySelector<HTMLElement>(".status-line")!;
    expect(scrolled).toEqual([]);
    await view.rerender({ state, onAction: () => {} });
    await tick();
    return { view, line };
  }

  it.each(["nothing", "restored", "failed", "verify"] as const)(
    "a result below the fold (%s) is scrolled into view and focused",
    async (state) => {
      const { line } = await conclude(state);
      expect(scrolled).toEqual([line]);
      expect(document.activeElement).toBe(line);
      expect(line).toHaveAttribute("tabindex", "-1");
      // The live region stays as it was, so the result is still announced.
      expect(line).toHaveAttribute("role", state === "failed" ? "alert" : "status");
    },
  );

  it("a result already fully visible is not scrolled, but still takes focus", async () => {
    below = false;
    const { line } = await conclude("nothing");
    expect(scrolled).toEqual([]);
    expect(document.activeElement).toBe(line);
  });

  it("a result shown without a check this visit (page load) neither scrolls nor takes focus", async () => {
    const view = render(RestoreStatusCard, { props: { state: "verify" as CardState, onAction: () => {} } });
    await tick();
    expect(scrolled).toEqual([]);
    expect(document.activeElement).not.toBe(view.container.querySelector(".status-line"));
  });

  it("Try again brings the next result into view again", async () => {
    const { view, line } = await conclude("failed");
    line.blur();
    scrolled = [];
    await view.rerender({ state: "checking" });
    await tick();
    expect(scrolled).toEqual([]);
    await view.rerender({ state: "restored" });
    await tick();
    expect(scrolled).toEqual([line]);
    expect(document.activeElement).toBe(line);
  });

  it("never takes focus from a text field the person is typing in", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    const view = render(RestoreStatusCard, { props: { state: "checking" as CardState } });
    field.focus();
    await view.rerender({ state: "nothing" });
    await tick();
    expect(scrolled).toHaveLength(1);
    expect(document.activeElement).toBe(field);
    field.remove();
  });
});
