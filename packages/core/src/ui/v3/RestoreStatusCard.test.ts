import { describe, it, expect, afterEach } from "vitest";
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
