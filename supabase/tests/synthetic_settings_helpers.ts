import postgres from "postgres";
import { signHs256 } from "../functions/_shared/jwt.ts";
export const A = "11111111-1111-4111-8111-111111111111";
export const B = "22222222-2222-4222-8222-222222222222";
export const C = "33333333-3333-4333-8333-333333333333";
export const SYNTHETIC_PASSWORD = "u3-synthetic-settings-only";
export function connection(
  url: string,
  user?: string,
  password?: string,
  onQuery?: () => void,
) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" || parsed.port !== "54322" ||
    parsed.pathname !== "/postgres"
  ) throw new Error("Disposable runner TCP target required");
  if (user) parsed.username = user;
  if (password) parsed.password = password;
  return postgres(parsed.href, {
    prepare: false,
    max: 4,
    onnotice: () => {},
    debug: onQuery ? () => onQuery() : undefined,
  });
}
export async function source(name: string) {
  return await Deno.readTextFile(
    new URL(`../../scripts/backend/sql/${name}.sql`, import.meta.url),
  );
}
export function write(
  read: { lineage: string; receipt: unknown },
  paths: [string, boolean][],
  base: number,
  step = 1,
) {
  return {
    protocol: 2,
    writeId: crypto.randomUUID(),
    expectedLineage: read.lineage,
    receipt: read.receipt,
    operations: paths.map(([path, value]) => ({
      path,
      value,
      baseRevision: base,
      localStep: step,
    })),
  };
}
export async function token(subject: string, secret: string, issuer?: string) {
  return await signHs256({
    sub: subject,
    role: "authenticated",
    aud: "authenticated",
    ...(issuer ? { iss: issuer } : {}),
    exp: Math.floor(Date.now() / 1000) + 300,
  }, secret);
}
