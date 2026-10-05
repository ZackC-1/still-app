import postgres from "postgres";
import {
  authenticatedClaims,
  signHs256,
  verifyJwt,
} from "../functions/_shared/jwt.ts";
import { isUuid } from "../functions/_shared/types.ts";
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
/** The numbered settings-sync migration, exactly as the CLI applies it. */
export async function migrationSource() {
  return await Deno.readTextFile(
    new URL("../migrations/0015_settings_sync_per_field.sql", import.meta.url),
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

// Maintained Auth endpoints only. This fixture never accepts a hosted target or
// prints an API/session response. Credentials exist only for this disposable run.
const AUTH_URL = "http://127.0.0.1:54321/auth/v1";
const AUTH_ISSUER = "http://kong:8000/auth/v1";
export async function createSyntheticSettingsAuthSession(apiKey: string) {
  if (!apiKey) throw new Error("synthetic-auth-api-key-required");
  const email = `u3-${crypto.randomUUID()}@example.invalid`;
  const password = crypto.randomUUID();
  async function request(path: string, body: unknown) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 2000);
    let status: number | null = null;
    try {
      const response = await fetch(`${AUTH_URL}/${path}`, {
        method: "POST",
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
      status = response.status;
      if (!response.ok) throw new Error("synthetic-auth-request-rejected");
      const data: unknown = await response.json();
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("synthetic-auth-response-shape");
      }
      return data as Record<string, unknown>;
    } catch {
      // Auth failures can carry emails, passwords, tokens and response bodies.
      const operation = path === "signup" ? "signup" : "password";
      throw new Error(
        `synthetic-auth-${operation}-unavailable:http-${status ?? "none"}`,
      );
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }
  const signup = await request("signup", { email, password });
  const session = await request("token?grant_type=password", {
    email,
    password,
  });
  const createdUser = signup.user ?? signup;
  const user = session.user;
  const bearer = session.access_token;
  if (
    createdUser === null || typeof createdUser !== "object" ||
    user === null || typeof user !== "object" ||
    !isUuid((user as Record<string, unknown>).id as string) ||
    (createdUser as Record<string, unknown>).id !==
      (user as Record<string, unknown>).id ||
    typeof bearer !== "string" || bearer.length > 16384 ||
    bearer.split(".").length !== 3
  ) throw new Error("synthetic-auth-session-shape");
  let header: Record<string, unknown>;
  try {
    const segment = bearer.split(".")[0]!;
    header = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new Error("synthetic-auth-token-shape");
  }
  if (
    header?.alg !== "ES256" || typeof header.kid !== "string" || !header.kid
  ) {
    throw new Error("synthetic-auth-es256-required");
  }
  // Validate the actual issued token using the same maintained verifier/claims
  // as the function. A requested issuer override or decoded header is not proof.
  const claims = await verifyJwt(bearer, {
    jwksUrl: `${AUTH_URL}/.well-known/jwks.json`,
    expected: authenticatedClaims("http://kong:8000"),
  });
  if (
    !claims || !isUuid(claims.sub) ||
    claims.sub !== (user as Record<string, unknown>).id ||
    claims.iss !== AUTH_ISSUER || !isUuid(claims.session_id as string) ||
    typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  ) throw new Error("synthetic-auth-jwks-or-claims-rejected");
  return {
    subject: claims.sub,
    sessionId: claims.session_id as string,
    bearer,
  };
}
