import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The unnumbered hardening candidate must pin SECURITY DEFINER functions the same way migration
// 0015 does: `pg_catalog, pg_temp`. An empty search_path still lets a caller's own temporary
// schema supply type names, so it is not accepted.
const source = await readFile(new URL("./sql/hardening-candidate.sql", import.meta.url), "utf8");
const code = source.replace(/^\s*--.*$/gm, "");

test("the hardening candidate pins every search_path to pg_catalog, pg_temp", () => {
  // Any case, with or without `=`: `SET search_path TO ...` is the same setting.
  const pins = [...code.matchAll(/set\s+search_path\s*(?:=|to)\s*([^;\n]*?)(?:;|\s+stable|\n|'\s*,)/gi)].map((m) =>
    m[1].trim().toLowerCase().replace(/\s+/g, " "),
  );
  assert.ok(pins.length >= 3, "the candidate pins the loop, write_profile_settings and get_current_rule_set");
  for (const pin of pins) assert.equal(pin, "pg_catalog, pg_temp");
  assert.doesNotMatch(code, /search_path\s*(?:=|to)\s*(?:''|%L|"")/i);
});
