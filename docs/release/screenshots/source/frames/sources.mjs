// The page each capture uses (sources.json); SOURCE_<KEY> in the environment overrides one, so
// candidate pages can be compared without editing anything: SOURCE_YOUTUBE=... node capture.mjs youtube
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "sources.json"), "utf8"));
const envKey = (k) => "SOURCE_" + k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
export const SOURCES = Object.fromEntries(Object.keys(file).filter((k) => !k.startsWith("_")).map((k) => [k, process.env[envKey(k)] || file[k]]));
