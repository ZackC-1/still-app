import {
  handleProductPolicyRead,
  type PolicyReader,
} from "../product-policy/handler.ts";
import { PgPolicyReader } from "../product-policy/pg-policy-reader.ts";
import {
  handleSyncSettings,
  type SyncSettingsDeps,
} from "../sync-settings/handler.ts";
import { authenticatedClaims } from "./jwt.ts";
import { type AuthDeps, withAuthenticatedUser } from "./auth.ts";
import { createWriterSql, PgRateLimiter } from "./pg-store.ts";
import { PgSettingsStore } from "./pg-settings-store.ts";
import { jsonResponse } from "./store.ts";

type ReadEnvironment = (name: string) => string | undefined;
type Handler = (request: Request) => Promise<Response>;
type SyncPorts = Pick<SyncSettingsDeps, "store" | "limiter">;

/** Normal shared policy/settings credentials are separate from QA purchase authority. */
function roleUrl(
  text: string,
  role: "still_policy_reader" | "still_settings_writer",
): boolean {
  try {
    const url = new URL(text);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      !!url.hostname &&
      !!url.password && url.pathname.length > 1 && !url.hash &&
      decodeURIComponent(url.username) === role;
  } catch {
    return false;
  }
}

/** Reuse the exact public policy parser/response contract, with only a fixed sandbox read. */
export function createQaSandboxPolicyHandler(
  read: ReadEnvironment,
  createReader: (url: string) => PolicyReader = (url) =>
    new PgPolicyReader(createWriterSql(url)),
): Handler {
  const database = read("PRODUCT_POLICY_READER_DB_URL") ?? "";
  let reader: PolicyReader | null = null;
  try {
    if (roleUrl(database, "still_policy_reader")) {
      reader = createReader(database);
    }
  } catch { /* unavailable */ }
  return (request) =>
    handleProductPolicyRead(request, {
      reader: {
        read: (namespace, environment) => {
          if (environment !== "sandbox" || !reader) {
            throw new Error("QA policy unavailable");
          }
          return reader.read(namespace, "sandbox");
        },
      },
    });
}

/** Free sync keeps its existing settings writer, JWT subject, limiter and revision semantics. */
export function createQaSandboxSyncHandler(
  read: ReadEnvironment,
  createPorts: (url: string) => SyncPorts = (url) => {
    const sql = createWriterSql(url);
    return { store: new PgSettingsStore(sql), limiter: new PgRateLimiter(sql) };
  },
): Handler {
  let deps: SyncSettingsDeps | null = null;
  let auth: AuthDeps = { jwtSecret: "" };
  try {
    const url = new URL(read("SUPABASE_URL") ?? "");
    const database = read("SETTINGS_WRITER_DB_URL") ?? "";
    if (
      url.protocol === "https:" && !url.username && !url.password &&
      !url.search &&
      !url.hash && url.pathname === "/"
    ) {
      auth = {
        jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",
        jwksUrl: `${url.origin}/auth/v1/.well-known/jwks.json`,
        expected: authenticatedClaims(url.origin),
      };
      if (roleUrl(database, "still_settings_writer")) {
        deps = { ...auth, ...createPorts(database) };
      }
    }
  } catch {
    /* Missing/malformed shared configuration must not construct a privileged fallback. */
  }
  return (request) => {
    if (deps) return handleSyncSettings(request, deps);
    return withAuthenticatedUser(
      request,
      auth,
      () =>
        Promise.resolve(jsonResponse(503, { error: "settings-unavailable" })),
    );
  };
}
