# Access proof fixtures

Use these synthetic fixtures to verify the shared TypeScript and Swift access boundary. They contain no customer, provider, production signing, or browsing data. The public synthetic test seed is documented in `vectors.json`; never use it for a production issuer.

The envelope and canonical payload tests cover maintained Ed25519 verification, domain separation, closed members, canonical encodings, environment, provenance and frozen benefit sets. Both languages consume the same vectors. The protected product and benefits in this file are test policy inputs, not the production protection snapshot.

Run the TypeScript cases with:

```sh
pnpm --filter @still/core exec vitest run src/entitlement/__tests__/access.test.ts
```

Run the native cases from `apps/apple/StillKit` with:

```sh
swift test --filter AccessProofTests
```

The tests also exercise fixed proof deadlines, persisted expiry and rollback latches, account lifecycle generations, independent local protection, failed durable writes, and the actual extension message broker. A repeated proof cannot renew its deadline. Access evidence is published only after the complete entitlement record commits; cached SDK booleans are not modern paid proofs.

`native-rights-probe.swift` exercises the actual atomic backing from independent native processes. Compile it against the built StillKit library, supply the vectors path and a disposable storage directory, then run seed/expire, concurrent stale/revoke writers, and check. Its inputs and output are synthetic. This does not establish App Group provisioning, suspension behavior on an iOS device, authoritative provider validation, production keys, or sales readiness.

Keep these JSON fixtures outside `tests/fixtures/`: that directory is reserved for hand-written browser HTML and has a privacy guard that deliberately rejects other file types.
