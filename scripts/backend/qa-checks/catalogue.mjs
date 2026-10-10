// The closed catalogue of read-only QA database checks (owner decision, 10 Oct 2026).
//
// Each check answers one or more "DB-xx" steps of the owner QA programme. A check is a fixed list
// of reviewed single-SELECT queries over the still_qa_checks views (sql-guard.mjs proves the
// shape; scripts/backend/sql/qa-readonly-checks-candidate.sql defines the views). Inputs are only
// a programme id and, where a check needs them, one or two QA account LABELS. Labels resolve to
// account ids inside the database through the owner-filled registry; no email, id or free-form
// SQL is ever an input. Every output column has a declared type that report.mjs enforces before
// anything is printed.

/** The nine designated Still QA accounts: workflow label -> programme name. */
export const LABELS = Object.freeze({
  preserved: "Preserved QA account",
  "web-chrome": "QA-Web-Chrome",
  "web-firefox": "QA-Web-Firefox",
  "web-android": "QA-Web-Android",
  fresh: "QA-Fresh",
  "refund-web": "Refund test (web)",
  "qa-a": "QA A",
  "qa-b": "QA B",
  delete: "QA-Delete",
});

const ENVIRONMENTS = ["sandbox", "production"];
const OPERATION_STATES = [
  "prepared",
  "session_bound",
  "paid_verified",
  "import_pending",
  "imported",
  "access_observed",
  "recovery_required",
  "refunded",
  "closed_unpaid",
];
const state = (...values) => ({ type: "state", values });
const ENV = state(...ENVIRONMENTS);
const SOURCE = state("revenuecat", "apple");
const PRODUCT = state("still_pro_v3", "still_sync");
const OP_STATE = state(...OPERATION_STATES);

const RIGHTS_FIELDS = {
  right_id: "ref",
  environment: ENV,
  provider_source: SOURCE,
  provider_product: PRODUCT,
  ownership_revision: "number",
  active: "bool",
  verified: "timestamp",
};
/** `account` is the label input (0 = first, 1 = second) bound to the query's only parameter. */
const rightsOf = (account) => ({
  name: "rights held by the account",
  sql:
    "select r.right_id, r.environment, r.provider_source, r.provider_product, r.ownership_revision, r.active, " +
    "pg_catalog.to_timestamp(r.verified_at / 1000.0) as verified from still_qa_checks.access_rights r " +
    "where r.holder = $1::uuid order by r.right_id",
  params: [account],
  fields: RIGHTS_FIELDS,
});
const operationsOf = {
  name: "checkout operations",
  sql:
    "select o.operation_id, o.status, o.environment, o.test_session, o.creation_started_at, o.paid_at, " +
    "o.created_at, o.updated_at from still_qa_checks.purchase_operations o where o.holder = $1::uuid order by o.created_at",
  fields: {
    operation_id: "ref",
    status: OP_STATE,
    environment: ENV,
    test_session: "bool",
    creation_started_at: "timestamp",
    paid_at: "timestamp",
    created_at: "timestamp",
    updated_at: "timestamp",
  },
};
const rightsCount = (account, column = "rights") => ({
  name: "rights count",
  sql: `select count(*) as ${column} from still_qa_checks.access_rights r where r.holder = $1::uuid`,
  params: [account],
  fields: { [column]: "count" },
});
const writesSummary = {
  name: "accepted settings writes logged (kept 30 days)",
  sql: "select w.writes, w.newest from still_qa_checks.settings_writes_summary w where w.user_id = $1::uuid",
  fields: { writes: "count", newest: "timestamp" },
};
const policyHeads = {
  name: "newest sales and rating policy revisions",
  sql: "select p.environment, p.namespace, p.newest from still_qa_checks.policy_heads p order by p.environment, p.namespace",
  fields: { environment: ENV, namespace: state("sales", "rating"), newest: "number" },
};
const productionFingerprint = {
  name: "production rights fingerprint (compare Session 0 with Session 11)",
  sql: "select f.rights, f.fingerprint from still_qa_checks.production_rights_fingerprint f",
  fields: { rights: "count", fingerprint: "fingerprint" },
};

const expectations = {
  baseline:
    "Hosted migration history ends at the expected version (0021 before this check route was installed). Exactly the designated QA accounts are enabled test accounts. The newest sandbox sales policy revision is the 'on' revision. The production rights fingerprint is captured for Session 11.",
  settingsWrite:
    "settings_version goes up by exactly 1 per accepted change, settings_server_updated_at moves forward, the last write id is logged, and the changed switch holds the new value. No purchase is needed.",
  checkoutStarted:
    "One operation for this account: environment sandbox, status session_bound, a Stripe test-mode session (cs_test_), paid_at empty. At most one open operation per account.",
  webPurchase:
    "Operation reaches access_observed with paid_at set. Exactly one right: sandbox, revenuecat, still_pro_v3, held by this account, active. Legacy entitlements unchanged (zero for QA accounts).",
  apple:
    "An Apple sandbox right for still_pro_v3 with no account holder, active, with a matching Apple observation. Nothing written for any Still account.",
  restore:
    "Still exactly one active sandbox right; verified time newer than before; the access observation for (account, sandbox) has a fresh deadline.",
  deletion:
    "Zero rows remain for the account in every Still table and Auth. Retained: rights with the holder emptied, and sandbox negative rights. Known findings to confirm: checkout operations are deleted with the account; an orphaned paid right keeps active true.",
  signOut: "Only the Supabase session count drops. Settings and rights are unchanged.",
};

/**
 * @typedef {"count" | "number" | "bool" | "timestamp" | "ref" | "version" | "fingerprint" | "label" | "key" | "name" | "switches" | { type: "state", values: string[] }} FieldType
 * @typedef {{ name: string, sql: string, params?: number[], fields: Record<string, FieldType> }} CheckQuery
 * @typedef {{ id: string, programIds: string[], title: string, expected: string, accounts: string[], allowDeletedAccount?: boolean, queries: CheckQuery[] }} Check
 */

/**
 * Checks, in programme order. `accounts` names the label inputs a check needs. A query binds
 * $1 = first account and $2 = second, unless its `params` lists which account (0 or 1) each of
 * its placeholders takes. `programIds` are the programme steps it answers.
 * @type {readonly Check[]}
 */
export const CHECKS = Object.freeze([
  {
    id: "setup",
    programIds: [],
    title: "Route readiness: the narrow read-only role and the QA account registry",
    expected: "The session is the narrow read-only role; all nine QA labels are registered.",
    accounts: [],
    queries: [
      {
        name: "registered QA labels",
        sql: "select a.label, a.auth_present from still_qa_checks.account_status a order by a.label",
        fields: { label: "label", auth_present: "bool" },
      },
    ],
  },
  {
    id: "baseline",
    programIds: ["DB-01", "DB-35"],
    title: "Baseline before testing (and unchanged by testing)",
    expected: expectations.baseline,
    accounts: [],
    queries: [
      {
        name: "newest hosted migrations",
        sql: "select m.version from still_qa_checks.migration_history m order by m.version desc limit 3",
        fields: { version: "version" },
      },
      {
        name: "QA sandbox test accounts",
        sql: "select count(*) filter (where s.enabled) as enabled_subjects, count(*) as total_subjects from still_qa_checks.qa_subjects s",
        fields: { enabled_subjects: "count", total_subjects: "count" },
      },
      policyHeads,
      {
        name: "paid cutoff environments",
        sql: "select c.environment from still_qa_checks.paid_cutoff_environments c order by c.environment",
        fields: { environment: ENV },
      },
      productionFingerprint,
    ],
  },
  {
    id: "account-identity",
    programIds: ["DB-02"],
    title: "Each QA label resolves to one confirmed account (no email exposed)",
    expected:
      "Each of the nine labels maps to exactly one Auth account: present, confirmed, not banned or deleted. Sandbox membership is shown for the paid-lane accounts (the free control and the deletion account are deliberately not members).",
    accounts: [],
    queries: [
      {
        name: "QA label status",
        sql:
          "select a.label, a.holder, a.auth_present, a.confirmed, a.banned, a.deleted, a.created_at, a.subject_enabled, " +
          "a.subject_revision from still_qa_checks.account_status a order by a.label",
        fields: {
          label: "label",
          holder: "ref",
          auth_present: "bool",
          confirmed: "bool",
          banned: "bool",
          deleted: "bool",
          created_at: "timestamp",
          subject_enabled: "bool",
          subject_revision: "number",
        },
      },
    ],
  },
  {
    id: "settings-write",
    programIds: ["DB-03", "DB-28"],
    title: "Each accepted settings change is stored once, with a server version",
    expected: expectations.settingsWrite,
    accounts: ["account"],
    queries: [
      {
        name: "settings document",
        sql:
          "select p.settings_version, p.settings_server_updated_at, p.settings -> 'globalOn' as global_on, " +
          "p.settings -> 'services' as services, p.settings -> 'sites' as sites, p.last_write_logged " +
          "from still_qa_checks.profiles p where p.id = $1::uuid",
        fields: {
          settings_version: "number",
          settings_server_updated_at: "timestamp",
          global_on: "bool",
          services: "switches",
          sites: "switches",
          last_write_logged: "bool",
        },
      },
      {
        name: "settings anchor",
        sql: "select a.modern_used from still_qa_checks.settings_anchors a where a.user_id = $1::uuid",
        fields: { modern_used: "bool" },
      },
      writesSummary,
    ],
  },
  {
    id: "settings-merge",
    programIds: ["DB-04"],
    title: "Two devices editing different switches both survive",
    expected:
      "Both changed fields are present in the one document; the version rose once per accepted change; each field's clock records its own revision. A retried write did not create a second change.",
    accounts: ["account"],
    queries: [
      {
        name: "settings document",
        sql:
          "select p.settings_version, p.settings -> 'services' as services, p.settings -> 'sites' as sites " +
          "from still_qa_checks.profiles p where p.id = $1::uuid",
        fields: { settings_version: "number", services: "switches", sites: "switches" },
      },
      {
        name: "per-field clocks",
        sql:
          "select c.key as field, c.value -> 'baseRevision' as base_revision, c.value -> 'localStep' as local_step " +
          "from still_qa_checks.profiles p, pg_catalog.jsonb_each(p.settings -> 'clocks') c where p.id = $1::uuid order by c.key",
        fields: { field: "key", base_revision: "number", local_step: "number" },
      },
      writesSummary,
    ],
  },
  {
    id: "first-sign-in",
    programIds: ["DB-05"],
    title: "First sign-in creates no settings or purchase rows by itself",
    expected:
      "Signing in creates only Auth records. No profile, entitlement or rights row until the first settings sync; then exactly one profile with schemaVersion 2.",
    accounts: ["account"],
    queries: [
      {
        name: "rows for the account",
        sql:
          "select (select count(*) from still_qa_checks.profiles p where p.id = $1::uuid) as profiles, " +
          "(select coalesce(sum(e.legacy_rows), 0) from still_qa_checks.entitlements_summary e where e.user_id = $1::uuid) as legacy_entitlements, " +
          "(select count(*) from still_qa_checks.access_rights r where r.holder = $1::uuid) as rights",
        fields: { profiles: "count", legacy_entitlements: "count", rights: "count" },
      },
      {
        name: "settings document",
        sql:
          "select p.settings_version, p.settings -> 'schemaVersion' as schema_version, p.settings_server_updated_at " +
          "from still_qa_checks.profiles p where p.id = $1::uuid",
        fields: { settings_version: "number", schema_version: "number", settings_server_updated_at: "timestamp" },
      },
    ],
  },
  {
    id: "settings-isolation",
    programIds: ["DB-06"],
    title: "Two accounts never share settings",
    expected: "Each account has its own profile row; the second document is not a copy of the first.",
    accounts: ["account", "account_b"],
    queries: [
      {
        name: "profiles",
        sql:
          "select p.id = $1::uuid as is_account_a, p.settings_version, pg_catalog.md5(p.settings::text) as document_fingerprint " +
          "from still_qa_checks.profiles p where p.id in ($1::uuid, $2::uuid) order by 1 desc",
        fields: { is_account_a: "bool", settings_version: "number", document_fingerprint: "fingerprint" },
      },
      {
        name: "distinct documents",
        sql:
          "select count(distinct pg_catalog.md5(p.settings::text)) as distinct_documents, count(*) as profiles " +
          "from still_qa_checks.profiles p where p.id in ($1::uuid, $2::uuid)",
        fields: { distinct_documents: "count", profiles: "count" },
      },
    ],
  },
  {
    id: "checkout-started",
    programIds: ["DB-07", "DB-10", "DB-38"],
    title: "Starting checkout records one sandbox operation",
    expected: expectations.checkoutStarted,
    accounts: ["account"],
    queries: [
      operationsOf,
      {
        name: "open operations",
        sql:
          "select count(*) as open_operations from still_qa_checks.purchase_operations o " +
          "where o.holder = $1::uuid and o.status not in ('refunded', 'closed_unpaid')",
        fields: { open_operations: "count" },
      },
    ],
  },
  {
    id: "checkout-cancelled",
    programIds: ["DB-08"],
    title: "Cancelling checkout grants nothing",
    expected:
      "The operation stays session_bound (or becomes closed_unpaid once Stripe expires it); paid_at empty; the account has no rights row.",
    accounts: ["account"],
    queries: [operationsOf, rightsCount(0)],
  },
  {
    id: "web-purchase",
    programIds: ["DB-09", "DB-12", "DB-21"],
    title: "A paid web purchase is recorded once, as sandbox, for the right account",
    expected: expectations.webPurchase,
    accounts: ["account"],
    queries: [
      operationsOf,
      rightsOf(0),
      {
        name: "legacy entitlements",
        sql: "select coalesce(sum(e.legacy_rows), 0) as legacy_entitlements from still_qa_checks.entitlements_summary e where e.user_id = $1::uuid",
        fields: { legacy_entitlements: "count" },
      },
    ],
  },
  {
    id: "account-switch",
    programIds: ["DB-11"],
    title: "Switching accounts mid-checkout cannot unlock the second account",
    expected:
      "The account signed in when checkout started (first label, the buyer) holds the one sandbox right. The second label (QA-Fresh) has no rights row and no purchase operation.",
    accounts: ["account", "account_b"],
    queries: [
      {
        name: "rights held by either account",
        sql:
          "select r.holder = $1::uuid as is_buyer, r.right_id, r.environment, r.provider_product, r.active " +
          "from still_qa_checks.access_rights r where r.holder in ($1::uuid, $2::uuid) order by 1 desc, r.right_id",
        fields: { is_buyer: "bool", right_id: "ref", environment: ENV, provider_product: PRODUCT, active: "bool" },
      },
      {
        name: "operations of either account",
        sql:
          "select o.holder = $1::uuid as is_buyer, o.status from still_qa_checks.purchase_operations o " +
          "where o.holder in ($1::uuid, $2::uuid) order by 1 desc, o.created_at",
        fields: { is_buyer: "bool", status: OP_STATE },
      },
    ],
  },
  {
    id: "apple-accountless",
    programIds: ["DB-13", "DB-14"],
    title: "An Apple sandbox purchase is verified without an account (last 30 minutes)",
    expected: expectations.apple,
    accounts: [],
    queries: [
      {
        name: "Apple sandbox rights verified in the last 30 minutes",
        sql:
          "select r.right_id, r.environment, r.provider_product, r.holder is null as accountless, r.ownership_revision, r.active, " +
          "pg_catalog.to_timestamp(r.verified_at / 1000.0) as verified, o.product_id, o.deadline " +
          "from still_qa_checks.access_rights r join still_qa_checks.apple_observations o on o.right_id = r.right_id " +
          "where r.provider_source = 'apple' and r.environment = 'sandbox' " +
          "and pg_catalog.to_timestamp(r.verified_at / 1000.0) > pg_catalog.now() - interval '30 minutes' order by r.verified_at desc",
        fields: {
          right_id: "ref",
          environment: ENV,
          provider_product: PRODUCT,
          accountless: "bool",
          ownership_revision: "number",
          active: "bool",
          verified: "timestamp",
          product_id: PRODUCT,
          deadline: "timestamp",
        },
      },
    ],
  },
  {
    id: "no-purchase",
    programIds: ["DB-15"],
    title: "A no-purchase account stays empty after Restore",
    expected: "The account has no rights rows and no purchase operation.",
    accounts: ["account"],
    queries: [
      {
        name: "rows for the account",
        sql:
          "select (select count(*) from still_qa_checks.access_rights r where r.holder = $1::uuid) as rights, " +
          "(select count(*) from still_qa_checks.purchase_operations o where o.holder = $1::uuid) as operations",
        fields: { rights: "count", operations: "count" },
      },
    ],
  },
  {
    id: "restore-refresh",
    programIds: ["DB-16", "DB-18"],
    title: "Restore refreshes the same right; it never creates a second one",
    expected: expectations.restore,
    accounts: ["account"],
    queries: [
      rightsOf(0),
      {
        name: "access observations",
        sql:
          "select o.environment, o.deadline, o.status from still_qa_checks.access_observations o " +
          "where o.holder = $1::uuid order by o.environment",
        fields: { environment: ENV, deadline: "timestamp", status: "key" },
      },
    ],
  },
  {
    id: "apple-link",
    programIds: ["DB-17"],
    title: "Linking an Apple purchase to a Still account is recorded once",
    expected:
      "The Apple sandbox right now has this account as holder with ownership_revision 1; one link operation targeting this account, no source, status linked.",
    accounts: ["account"],
    queries: [
      rightsOf(0),
      {
        name: "Apple link operations involving the account",
        sql:
          "select l.environment, l.target_holder = $1::uuid as is_target, l.source_holder is null as no_source, " +
          "l.expected_revision, l.resulting_revision, l.status from still_qa_checks.apple_link_operations l " +
          "where $1::uuid in (l.target_holder, l.source_holder) order by l.resulting_revision",
        fields: {
          environment: ENV,
          is_target: "bool",
          no_source: "bool",
          expected_revision: "number",
          resulting_revision: "number",
          status: state("linked", "already_linked"),
        },
      },
    ],
  },
  {
    id: "sign-in-no-move",
    programIds: ["DB-19"],
    title: "Signing in alone never moves Pro",
    expected:
      "After the second account signs in on a device where the first had Pro, the first account still holds the same right (same reference) with an unchanged ownership_revision, and the second has no rights row.",
    accounts: ["account", "account_b"],
    queries: [rightsOf(0), rightsCount(1, "account_b_rights")],
  },
  {
    id: "transfer",
    programIds: ["DB-20"],
    title: "A confirmed transfer leaves exactly one owner",
    expected:
      "The right is now held by the second account with ownership_revision +1; a link operation from the first to the second account, status linked; a sandbox revocation for the first account with the new revision. No sandbox transfer operations (that route has no caller).",
    accounts: ["account", "account_b"],
    queries: [
      { ...rightsOf(1), name: "rights held by the second account" },
      rightsCount(0, "account_a_rights"),
      {
        name: "link operations into the second account",
        sql:
          "select l.source_holder = $1::uuid as from_account_a, l.target_holder = $2::uuid as to_account_b, l.status, l.resulting_revision " +
          "from still_qa_checks.apple_link_operations l where l.target_holder = $2::uuid order by l.resulting_revision",
        fields: {
          from_account_a: "bool",
          to_account_b: "bool",
          status: state("linked", "already_linked"),
          resulting_revision: "number",
        },
      },
      {
        name: "sandbox revocations for the first account",
        sql:
          "select v.right_id, v.revision from still_qa_checks.access_revocations v " +
          "where v.holder = $1::uuid and v.environment = 'sandbox' order by v.right_id",
        fields: { right_id: "ref", revision: "number" },
      },
      {
        name: "sandbox transfer operations",
        sql: "select i.sandbox_transfer_operations from still_qa_checks.isolation_summary i",
        fields: { sandbox_transfer_operations: "count" },
      },
    ],
  },
  {
    id: "refund-revokes",
    programIds: ["DB-22"],
    title: "A Stripe sandbox refund revokes exactly that right",
    expected:
      "Operation refunded (paid_at kept); one sandbox negative right; the right inactive with ownership_revision +1; one revocation for the account. If the operation is still imported or access_observed, RevenueCat has not caught up: record the minutes and re-run.",
    accounts: ["account"],
    queries: [
      operationsOf,
      rightsOf(0),
      {
        name: "negative rights for the account's rights",
        sql:
          "select n.right_id, n.environment, n.revoked_at from still_qa_checks.negative_rights n " +
          "join still_qa_checks.access_rights r on r.right_id = n.right_id where r.holder = $1::uuid order by n.revoked_at",
        fields: { right_id: "ref", environment: ENV, revoked_at: "timestamp" },
      },
      {
        name: "revocations for the account",
        sql:
          "select v.right_id, v.environment, v.revision from still_qa_checks.access_revocations v " +
          "where v.holder = $1::uuid order by v.right_id",
        fields: { right_id: "ref", environment: ENV, revision: "number" },
      },
    ],
  },
  {
    id: "pro-choices",
    programIds: ["DB-23"],
    title: "Pro choices are ordinary settings and never grant access",
    expected:
      "A Pro switch turned on is stored in the sites settings like any other choice; with Pro refunded, the account has no active right.",
    accounts: ["account"],
    queries: [
      {
        name: "sites settings",
        sql: "select p.settings -> 'sites' as sites from still_qa_checks.profiles p where p.id = $1::uuid",
        fields: { sites: "switches" },
      },
      {
        name: "rights",
        sql:
          "select count(*) as rights, count(*) filter (where r.active) as active_rights " +
          "from still_qa_checks.access_rights r where r.holder = $1::uuid",
        fields: { rights: "count", active_rights: "count" },
      },
    ],
  },
  {
    id: "refund-twice",
    programIds: ["DB-24"],
    title: "Refunding twice changes nothing more",
    expected: "Still one negative right and one revocation for that right; ownership_revision unchanged since the first refund.",
    accounts: ["account"],
    queries: [
      {
        name: "negative rights and revocations",
        sql:
          "select (select count(*) from still_qa_checks.negative_rights n join still_qa_checks.access_rights r on r.right_id = n.right_id " +
          "where r.holder = $1::uuid) as negative_rights, " +
          "(select count(*) from still_qa_checks.access_revocations v where v.holder = $1::uuid) as revocations",
        fields: { negative_rights: "count", revocations: "count" },
      },
      rightsOf(0),
    ],
  },
  {
    id: "rebuy",
    programIds: ["DB-25"],
    title: "Buying again after a refund creates a new right; the refunded one stays revoked",
    expected: "A second operation reaches access_observed; a new active sandbox right exists; the refunded right stays inactive with its negative right.",
    accounts: ["account"],
    queries: [
      operationsOf,
      rightsOf(0),
      {
        name: "negative rights for the account's rights",
        sql:
          "select n.right_id, n.revoked_at from still_qa_checks.negative_rights n " +
          "join still_qa_checks.access_rights r on r.right_id = n.right_id where r.holder = $1::uuid order by n.revoked_at",
        fields: { right_id: "ref", revoked_at: "timestamp" },
      },
    ],
  },
  {
    id: "sign-out",
    programIds: ["DB-26", "DB-27"],
    title: "Signing out writes nothing to Still's tables",
    expected: expectations.signOut,
    accounts: ["account"],
    queries: [
      {
        name: "sessions, settings version and active rights",
        sql:
          "select (select coalesce(sum(s.sessions), 0) from still_qa_checks.sessions_summary s where s.user_id = $1::uuid) as sessions, " +
          "(select p.settings_version from still_qa_checks.profiles p where p.id = $1::uuid) as settings_version, " +
          "(select count(*) filter (where r.active) from still_qa_checks.access_rights r where r.holder = $1::uuid) as active_rights",
        fields: { sessions: "count", settings_version: "number", active_rights: "count" },
      },
    ],
  },
  {
    id: "account-deleted",
    programIds: ["DB-29", "DB-30"],
    title: "Account deletion removes the account's data and keeps what policy says",
    expected: expectations.deletion,
    accounts: ["account"],
    allowDeletedAccount: true,
    queries: [
      {
        name: "Auth account",
        sql: "select a.auth_present, a.subject_enabled is not null as qa_subject from still_qa_checks.account_status a where a.holder = $1::uuid",
        fields: { auth_present: "bool", qa_subject: "bool" },
      },
      {
        name: "rows left for the account",
        sql:
          "select (select count(*) from still_qa_checks.profiles p where p.id = $1::uuid) as profiles, " +
          "(select coalesce(sum(e.legacy_rows), 0) from still_qa_checks.entitlements_summary e where e.user_id = $1::uuid) as legacy_entitlements, " +
          "(select count(*) from still_qa_checks.settings_anchors a where a.user_id = $1::uuid) as settings_anchors, " +
          "(select coalesce(sum(w.writes), 0) from still_qa_checks.settings_writes_summary w where w.user_id = $1::uuid) as settings_writes, " +
          "(select coalesce(sum(c.buckets), 0) from still_qa_checks.rate_limit_summary c where c.account_id = $1::uuid) as rate_limit_rows, " +
          "(select count(*) from still_qa_checks.access_observations o where o.holder = $1::uuid) as access_observations, " +
          "(select count(*) from still_qa_checks.access_revocations v where v.holder = $1::uuid) as access_revocations, " +
          "(select count(*) from still_qa_checks.qa_subjects s where s.holder = $1::uuid) as qa_subject_rows, " +
          "(select count(*) from still_qa_checks.purchase_operations o where o.holder = $1::uuid) as purchase_operations, " +
          "(select coalesce(sum(s.subjects), 0) from still_qa_checks.analytics_subjects_summary s where s.user_id = $1::uuid) as analytics_subjects, " +
          "(select coalesce(sum(s.sessions), 0) from still_qa_checks.sessions_summary s where s.user_id = $1::uuid) as sessions, " +
          "(select count(*) from still_qa_checks.access_rights r where r.holder = $1::uuid) as rights_still_held",
        fields: {
          profiles: "count",
          legacy_entitlements: "count",
          settings_anchors: "count",
          settings_writes: "count",
          rate_limit_rows: "count",
          access_observations: "count",
          access_revocations: "count",
          qa_subject_rows: "count",
          purchase_operations: "count",
          analytics_subjects: "count",
          sessions: "count",
          rights_still_held: "count",
        },
      },
      {
        name: "sandbox rights with no holder (compare references with the run before deletion)",
        sql:
          "select r.right_id, r.provider_source, r.provider_product, r.active, r.ownership_revision from still_qa_checks.access_rights r " +
          "where r.holder is null and r.environment = 'sandbox' order by r.right_id",
        fields: { right_id: "ref", provider_source: SOURCE, provider_product: PRODUCT, active: "bool", ownership_revision: "number" },
      },
      {
        name: "negative rights on rights with no holder",
        sql:
          "select n.right_id, n.revoked_at from still_qa_checks.negative_rights n " +
          "join still_qa_checks.access_rights r on r.right_id = n.right_id where r.holder is null order by n.right_id",
        fields: { right_id: "ref", revoked_at: "timestamp" },
      },
      {
        name: "analytics erasure jobs created in the last hour",
        sql:
          "select j.scope, j.stage, count(*) as jobs from still_qa_checks.erasure_jobs j " +
          "where j.created_at > pg_catalog.now() - interval '1 hour' group by j.scope, j.stage order by 1, 2",
        fields: {
          scope: state("device", "account_deleted"),
          stage: state("stop_recorded", "provider_delete_accepted", "provider_delete_confirmed", "complete"),
          jobs: "count",
        },
      },
    ],
  },
  {
    id: "sandbox-isolation",
    programIds: ["DB-31"],
    title: "Sandbox never touched production",
    expected:
      "Every right held by a QA account is sandbox; no negative right points at a production right; QA accounts have no legacy entitlements; the production fingerprint equals the Session 0 value; production policy revisions unchanged.",
    accounts: [],
    queries: [
      {
        name: "rights by environment, provider and product",
        sql:
          "select s.environment, s.provider_source, s.provider_product, s.total, s.active from still_qa_checks.rights_summary s " +
          "order by s.environment, s.provider_source, s.provider_product",
        fields: { environment: ENV, provider_source: SOURCE, provider_product: PRODUCT, total: "count", active: "count" },
      },
      {
        name: "isolation counts",
        sql:
          "select i.qa_non_sandbox_rights, i.cross_environment_negative_rights, i.qa_legacy_entitlements " +
          "from still_qa_checks.isolation_summary i",
        fields: { qa_non_sandbox_rights: "count", cross_environment_negative_rights: "count", qa_legacy_entitlements: "count" },
      },
      productionFingerprint,
      policyHeads,
    ],
  },
  {
    id: "private-grants",
    programIds: ["DB-32"],
    title: "Ordinary signed-in users cannot read or write the private ledgers (catalog only)",
    expected:
      "No PUBLIC, anon or authenticated grant on any private table or private function; row security recorded as found.",
    accounts: [],
    queries: [
      {
        name: "client grants on private tables",
        sql:
          "select c.relname as relation, case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as grantee, " +
          "a.privilege_type from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace " +
          "cross join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a " +
          "where n.nspname = 'private' and c.relkind in ('r', 'p') " +
          "and (a.grantee = 0 or pg_catalog.pg_get_userbyid(a.grantee) in ('anon', 'authenticated')) order by 1, 2, 3",
        fields: { relation: "name", grantee: "name", privilege_type: "name" },
      },
      {
        name: "client EXECUTE on private functions",
        sql:
          "select p.proname as routine, case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as grantee " +
          "from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace " +
          "cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a " +
          "where n.nspname = 'private' and a.privilege_type = 'EXECUTE' " +
          "and (a.grantee = 0 or pg_catalog.pg_get_userbyid(a.grantee) in ('anon', 'authenticated')) order by 1, 2",
        fields: { routine: "name", grantee: "name" },
      },
      {
        name: "row security on private tables",
        sql:
          "select c.relname as relation, c.relrowsecurity as row_security from pg_catalog.pg_class c " +
          "join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relkind in ('r', 'p') order by 1",
        fields: { relation: "name", row_security: "bool" },
      },
    ],
  },
  {
    id: "retention",
    programIds: ["DB-33"],
    title: "Short-lived records really are short-lived (whole database, counts only)",
    expected: "No settings write older than 30 days; rate-limit buckets expire; no expired QA rate windows linger.",
    accounts: [],
    queries: [
      {
        name: "expired rows still present",
        sql:
          "select r.writes_older_than_30_days, r.expired_rate_rows, r.expired_qa_rate_windows from still_qa_checks.retention_summary r",
        fields: { writes_older_than_30_days: "count", expired_rate_rows: "count", expired_qa_rate_windows: "count" },
      },
    ],
  },
  {
    id: "test-account-markers",
    programIds: ["DB-34"],
    title: "Test accounts are marked server-side and easy to exclude",
    expected:
      "The sandbox member list is exactly the paid-lane QA accounts (enabled); all their rights are sandbox. Known gap: their profile rows carry no test marker, so exclusion relies on joining the member list.",
    accounts: [],
    queries: [
      {
        name: "sandbox members",
        sql: "select s.label, s.enabled from still_qa_checks.qa_subjects s order by s.label",
        fields: { label: "label", enabled: "bool" },
      },
      {
        name: "member profiles and non-sandbox rights",
        sql: "select i.subject_profiles, i.qa_non_sandbox_rights from still_qa_checks.isolation_summary i",
        fields: { subject_profiles: "count", qa_non_sandbox_rights: "count" },
      },
    ],
  },
  {
    id: "no-browsing-history",
    programIds: ["DB-37"],
    title: "No browsing history is stored anywhere (whole database)",
    expected:
      "No column in public or private named like a URL, page, visit, history, title, search or referrer; settings documents hold only the known keys; rate-limit keys are hashed.",
    accounts: [],
    queries: [
      {
        name: "columns named like browsing data",
        sql:
          "select n.nspname as schema_name, c.relname as relation, a.attname as column_name from pg_catalog.pg_attribute a " +
          "join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace " +
          "where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped " +
          "and a.attname ~* '(url|uri|page|visit|histor|referr|title|browse|search|user_agent)' order by 1, 2, 3",
        fields: { schema_name: "name", relation: "name", column_name: "name" },
      },
      {
        name: "unknown settings keys and unhashed rate-limit keys",
        sql: "select p.unknown_settings_keys, p.unhashed_rate_keys from still_qa_checks.privacy_summary p",
        fields: { unknown_settings_keys: "count", unhashed_rate_keys: "count" },
      },
    ],
  },
]);

/** Programme steps that cannot be answered by a read-only query, with the reason. */
export const NOT_READ_ONLY = Object.freeze({
  "DB-36":
    "Engineering-only cases (failed-transaction rollback, provider outage, bounded concurrency, query speed, backup restore, monitoring alerts) need fault injection or writes; record engineering's result instead.",
});

/** Workflow `check` input values: the readiness check, then every programme id a check answers. */
export const CHECK_INPUTS = Object.freeze([
  "setup",
  ...CHECKS.flatMap((c) => c.programIds).sort(),
]);

export class InputError extends Error {}

/** Resolves workflow inputs to a check and its ordered labels, or throws InputError. */
/**
 * The label positions bound to a query's $1, $2, ... (see `params`).
 * @param {CheckQuery} query
 * @param {number} accountCount
 * @returns {number[]}
 */
export function queryParams(query, accountCount) {
  if (query.params) return query.params;
  const used = Math.max(0, ...[...query.sql.matchAll(/\$([1-9])/g)].map((m) => Number(m[1])));
  return Array.from({ length: Math.min(used, accountCount) }, (_, i) => i);
}

export function resolveRequest({ check, account = "none", accountB = "none" }) {
  if (NOT_READ_ONLY[check]) throw new InputError(`${check} is not a read-only check: ${NOT_READ_ONLY[check]}`);
  const entry = CHECKS.find((c) => c.id === check || c.programIds.includes(check));
  if (!entry || !CHECK_INPUTS.includes(check)) throw new InputError("Unknown check id");
  const given = [account, accountB].map((v) => (v === undefined || v === "" ? "none" : v));
  for (const label of given)
    if (label !== "none" && !Object.hasOwn(LABELS, label)) throw new InputError("Unknown QA account label");
  const labels = given.slice(0, entry.accounts.length);
  if (labels.some((l) => l === "none"))
    throw new InputError(`${check} needs ${entry.accounts.length === 1 ? "one QA account label" : "two QA account labels"}`);
  if (given.slice(entry.accounts.length).some((l) => l !== "none"))
    throw new InputError(`${check} takes ${entry.accounts.length} QA account label(s); leave the others as none`);
  if (labels.length === 2 && labels[0] === labels[1]) throw new InputError("The two QA account labels must differ");
  return { check: entry, programId: check, labels };
}
