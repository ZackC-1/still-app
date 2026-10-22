# Writes account-holds-pro-vectors.json from the public synthetic vectors (see README.md).
# Usage: python3 generate-account-holds-pro-vectors.py <vectors.json> <output.json>
import json, base64, sys
vectors_path, out_path = sys.argv[1], sys.argv[2]
d = json.load(open(vectors_path))
env = {v["name"]: v["envelope"] for v in d["vectors"]}
def identity(name):
    e = json.loads(env[name]); s = e["signature"]; s += "=" * (-len(s) % 4)
    return e["kid"] + ":" + base64.urlsafe_b64decode(s).hex()
ACCOUNT = d["account"]; OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
V, E = d["verifiedAt"], d["expiresAt"]
GEN = 4
def clock(name, **flags):
    c = {"proofIdentity": identity(name), "verifiedAt": V, "expiresAt": E, "issuerTimeAtReceipt": V,
         "wallAtReceipt": 1000, "highWater": V, "lastWall": 1000, "expired": False, "revoked": False, "paused": False}
    c.update(flags); return c
def right(name, gen=GEN, **flags):
    return {"envelope": env[name], "clock": clock(name, **flags) if name.startswith("paid") else None, "accountGeneration": gen}
def record(rights, accountId=ACCOUNT, sessionId=SESSION, **extra):
    r = {"schema": 1, "accountId": accountId, "generation": GEN, "sessionId": sessionId, "rights": rights, "revocations": []}
    r.update(extra); return r
cases = [
  ("account proof", "synthetic", record([right("paid-account")]), True),
  ("owner-attested account proof", "synthetic", record([right("paid-owner-attested")]), True),
  ("account proof beside a device-only proof", "synthetic", record([right("paid-apple-local", gen=None), right("paid-account")]), True),
  ("device-only proof", "synthetic", record([right("paid-apple-local", gen=None)]), False),
  ("device-only proof while signed out", "synthetic", record([right("paid-apple-local", gen=None)], accountId=None, sessionId=None), False),
  ("free protected account proof", "synthetic", record([right("protected-account")]), False),
  ("another account signed in", "synthetic", record([right("paid-account")], accountId=OTHER), False),
  ("older session generation", "synthetic", record([right("paid-account", gen=GEN - 1)]), False),
  ("revoked clock", "synthetic", record([right("paid-account", revoked=True)]), False),
  ("expired clock", "synthetic", record([right("paid-account", expired=True)]), False),
  ("paused clock", "synthetic", record([right("paid-account", paused=True)]), False),
  ("revoked right", "synthetic", record([right("paid-account")], revocations=[{"right": "11111111-1111-4111-8111-111111111111", "revision": 1}]), False),
  ("revoked for this account", "synthetic", record([right("paid-account")], accountRevocations=[{"holder": ACCOUNT, "right": "11111111-1111-4111-8111-111111111111", "revision": 1}]), False),
  ("untrusted signing key", "other-key", record([right("paid-account")]), False),
  ("other environment", "production", record([right("paid-account")]), False),
]
# The proof deadline, read at the reader's wall clock with every clock flag false and a clock that
# has not reached it either, so `wall < expires_at` alone decides (catches a `<` / `<=` drift).
boundary = dict(wallAtReceipt=E - 2, lastWall=E - 2)
timed = [
  ("one millisecond before the proof deadline", "synthetic", record([right("paid-account", **boundary)]), True, E - 1),
  ("at the proof deadline", "synthetic", record([right("paid-account", **boundary)]), False, E),
]
out = {
  "notice": "Synthetic. Envelopes are the public test vectors in vectors.json (seed byte07 repeated 32); no production key, customer or provider record. Regenerate with generate-account-holds-pro-vectors.py.",
  "snapshotKeys": ["accountHoldsPro", "accountHoldsProFor", "generation", "independentProtection", "refreshAfterMs", "schema", "states"],
  "legacySnapshotKeys": ["generation", "independentProtection", "refreshAfterMs", "schema", "states"],
  "wall": 2000,
  "sessionId": SESSION,
  # A valid Ed25519 public key that did not sign any vector (RFC 8032 test 1).
  "otherPublicKeyHex": "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "cases": [{"name": n, "trust": t, "record": r, "accountHoldsPro": x} for n, t, r, x in cases] +
           [{"name": n, "trust": t, "record": r, "accountHoldsPro": x, "wall": w} for n, t, r, x, w in timed],
}
json.dump(out, open(out_path, "w"), indent=2); open(out_path, "a").write("\n")
