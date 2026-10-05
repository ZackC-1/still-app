import { assert, assertEquals } from "@std/assert";
import {
  canonicalPolicyBody,
  parsePolicyBody,
  remoteSurfaceSummary,
  renderDraft,
} from "./policy-wire.ts";

const OFF_SURFACES = {
  chrome_desktop: false,
  edge_desktop: false,
  firefox_desktop: false,
  firefox_android: false,
  apple_mobile_host: false,
  apple_macos_host: false,
};
const RATING_DRAFT = {
  master: true,
  surfaces: { ...OFF_SURFACES, chrome_desktop: true, edge_desktop: true },
  builds: [{ surface: "chrome_desktop", build: "3.0.0" }, {
    surface: "edge_desktop",
    build: "3.0.0",
  }],
};
const SALES_DRAFT = {
  // Deliberately out of canonical order: rendering fixes the order.
  builds: [{ build: "3.0.0", surface: "apple_mobile_host" }],
  channels: {
    web: { offer: "still-pro-v3", enabled: false },
    apple: { enabled: true, offer: "still-pro-v3" },
  },
  salesEnabled: true,
};
const RATING_BODY =
  '{"schema":1,"environment":"sandbox","revision":4,"master":true,"surfaces":{"chrome_desktop":true,"edge_desktop":true,"firefox_desktop":false,"firefox_android":false,"apple_mobile_host":false,"apple_macos_host":false},"builds":[{"surface":"chrome_desktop","build":"3.0.0"},{"surface":"edge_desktop","build":"3.0.0"}]}';
const SALES_BODY =
  '{"schema":1,"environment":"production","revision":1,"salesEnabled":true,"channels":{"apple":{"enabled":true,"offer":"still-pro-v3"},"web":{"enabled":false,"offer":"still-pro-v3"}},"builds":[{"surface":"apple_mobile_host","build":"3.0.0"}]}';

Deno.test("renderDraft emits the one canonical body in the shared grammar", () => {
  assertEquals(renderDraft("rating", "sandbox", 4, RATING_DRAFT), RATING_BODY);
  assertEquals(renderDraft("sales", "production", 1, SALES_DRAFT), SALES_BODY);
  // The canonical body round-trips through the shared grammar unchanged.
  for (
    const [namespace, environment, body] of [
      ["rating", "sandbox", RATING_BODY],
      ["sales", "production", SALES_BODY],
    ] as const
  ) {
    const policy = parsePolicyBody(namespace, environment, body);
    assert(policy);
    assertEquals(canonicalPolicyBody(namespace, policy), body);
  }
});

Deno.test("renderDraft refuses anything outside the closed grammar", () => {
  const bad: [string, unknown][] = [
    ["envelope key", { ...RATING_DRAFT, revision: 9 }],
    ["schema key", { ...RATING_DRAFT, schema: 2 }],
    ["unknown key", { ...RATING_DRAFT, reviewUrl: "https://example.invalid" }],
    ["free text", { ...RATING_DRAFT, master: "yes" }],
    ["url as build", {
      ...RATING_DRAFT,
      builds: [{ surface: "chrome_desktop", build: "https://x" }],
    }],
    ["escape in build", {
      ...RATING_DRAFT,
      builds: [{ surface: "chrome_desktop", build: 'a"b' }],
    }],
    ["non-ascii build", {
      ...RATING_DRAFT,
      builds: [{ surface: "chrome_desktop", build: "é" }],
    }],
    ["unknown surface", {
      ...RATING_DRAFT,
      builds: [{ surface: "android_native", build: "3.0.0" }],
    }],
    ["duplicate build", {
      ...RATING_DRAFT,
      builds: [RATING_DRAFT.builds[0], RATING_DRAFT.builds[0]],
    }],
    [
      "too many builds",
      {
        ...RATING_DRAFT,
        builds: Array.from(
          { length: 33 },
          (_, i) => ({ surface: "chrome_desktop", build: `b${i}` }),
        ),
      },
    ],
    ["missing surface flag", {
      ...RATING_DRAFT,
      surfaces: { chrome_desktop: true },
    }],
    ["array draft", [RATING_DRAFT]],
    ["null draft", null],
  ];
  for (const [name, draft] of bad) {
    assertEquals(renderDraft("rating", "sandbox", 1, draft), null, name);
  }
  assertEquals(
    renderDraft("sales", "sandbox", 1, {
      ...SALES_DRAFT,
      channels: {
        ...SALES_DRAFT.channels,
        web: { enabled: true, offer: "still-sync" },
      },
    }),
    null,
    "unreviewed offer",
  );
  assertEquals(
    renderDraft("sales", "sandbox", 1, {
      ...SALES_DRAFT,
      paidTierEnabled: true,
    }),
    null,
    "paid flag",
  );
  assertEquals(
    renderDraft("rating", "sandbox", 0, RATING_DRAFT),
    null,
    "revision 0",
  );
  assertEquals(
    renderDraft("sales", "sandbox", 1, RATING_DRAFT),
    null,
    "wrong namespace",
  );
});

Deno.test("parsePolicyBody binds namespace, environment and revision", () => {
  assert(parsePolicyBody("rating", "sandbox", RATING_BODY, 4));
  assertEquals(parsePolicyBody("rating", "production", RATING_BODY), null);
  assertEquals(parsePolicyBody("rating", "sandbox", RATING_BODY, 5), null);
  assertEquals(parsePolicyBody("sales", "sandbox", RATING_BODY), null);
  assertEquals(
    parsePolicyBody(
      "rating",
      "sandbox",
      RATING_BODY.replace('"master":true', '"master":true,"master":true'),
    ),
    null,
  );
});

Deno.test("remote summary: deferred Edge is inert, sales follows its packaged channel", () => {
  const rating = parsePolicyBody("rating", "sandbox", RATING_BODY)!;
  assertEquals(remoteSurfaceSummary("rating", rating), {
    ...OFF_SURFACES,
    chrome_desktop: true,
  });
  const sales = parsePolicyBody("sales", "production", SALES_BODY)!;
  assertEquals(remoteSurfaceSummary("sales", sales), {
    ...OFF_SURFACES,
    apple_mobile_host: true,
  });
  assertEquals(remoteSurfaceSummary("sales", null), OFF_SURFACES);
  const masterOff = parsePolicyBody(
    "rating",
    "sandbox",
    RATING_BODY.replace('"master":true', '"master":false'),
  )!;
  assertEquals(remoteSurfaceSummary("rating", masterOff), OFF_SURFACES);
});
