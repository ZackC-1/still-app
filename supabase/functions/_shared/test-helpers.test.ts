import { assertEquals } from "@std/assert";
import { captureConsole } from "./test-helpers.ts";

Deno.test("captureConsole formats BigInt and circular values instead of throwing inside the code under test", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let threw = false;
  const logged = await captureConsole(() => {
    try {
      console.error("big", 10n, "loop", circular);
    } catch {
      threw = true;
    }
    return Promise.resolve();
  });
  assertEquals(threw, false);
  assertEquals(logged, "big 10 loop [object Object]");
});

Deno.test("captureConsole restores console and captures every level", async () => {
  const before = console.error;
  const logged = await captureConsole(() => {
    console.log("a");
    console.info("b");
    console.warn("c");
    console.error("d");
    console.debug("e");
    return Promise.resolve();
  });
  assertEquals(logged, "a\nb\nc\nd\ne");
  assertEquals(console.error, before);
});
