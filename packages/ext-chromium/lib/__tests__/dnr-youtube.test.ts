import { describe, it, expect } from "vitest";
import rules from "../../public/rules/dnr-youtube.json";

// The DNR redirect is Chrome's, not ours, at runtime — but its regex is ours to get right. Chrome's
// regexSubstitution replaces ONLY the matched substring and appends any unmatched tail, so the filter
// must consume the whole URL: a shared link like /shorts/<id>?si=… must not become watch?v=<id>?si=….
function applyRule(url: string): string | null {
  const rule = rules[0]!;
  const re = new RegExp(rule.condition.regexFilter);
  const m = re.exec(url);
  if (!m) return null;
  const substituted = rule.action.redirect.regexSubstitution.replace(/\\(\d)/g, (_, i) => m[Number(i)] ?? "");
  return url.slice(0, m.index) + substituted + url.slice(m.index + m[0].length);
}

describe("dnr-youtube redirect rule", () => {
  it("redirects a bare Shorts URL to the watch page", () => {
    expect(applyRule("https://www.youtube.com/shorts/abc123")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
  });

  it("consumes the query tail of a shared Shorts URL", () => {
    expect(applyRule("https://www.youtube.com/shorts/abc123?si=xyz&t=4")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
  });

  it("handles the mobile host and hyphen/underscore video ids", () => {
    expect(applyRule("https://m.youtube.com/shorts/a-b_c?feature=share")).toBe(
      "https://www.youtube.com/watch?v=a-b_c",
    );
  });

  it("ignores non-Shorts URLs", () => {
    expect(applyRule("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(applyRule("https://www.youtube.com/feed/shorts")).toBeNull();
  });
});
