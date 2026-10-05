"""Regenerate packages/shared-types/fixtures/sync-reference-vectors.json:

    python3 scripts/sync-vectors/generate.py --out packages/shared-types/fixtures/sync-reference-vectors.json

Without --out the JSON goes to stdout. With --out it is written to a temporary file and moved into
place only after every check passes, so a failed run never leaves the fixture empty.

Emit explicit shared vectors from the pure ordering reference model.

Runs the reference model itself (which must PASS with exactly 6,558 checks),
then re-derives one explicit vector per reference assertion with its expected
outcome, so TS, Swift and the Deno server runner compare against data rather
than against each other.
"""
import base64
import hashlib
import hmac
import json
import runpy
import sys
from itertools import product

import contextlib
import os

args = sys.argv[1:]
OUT_PATH = None
if args[:1] == ["--out"]:
    OUT_PATH, args = args[1], args[2:]
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference.py")
assert not args, "usage: generate.py [--out PATH]"
with contextlib.redirect_stdout(sys.stderr):
    ref = runpy.run_path(MODEL_PATH, run_name="reference")
assert ref["checks"] == 6558, ref["checks"]
Field, merge, edit = ref["Field"], ref["merge"], ref["edit"]
MAX_SAFE, MAX_STEP = ref["MAX_SAFE"], ref["MAX_STEP"]
pending_after_ack = ref["pending_after_ack"]

domain = [Field(b, s, e) for b, s, e in product(range(3), range(3), (False, True))]
assert domain == ref["domain"]
index = {f: i for i, f in enumerate(domain)}


def js(f):
    return {"value": f.enabled, "stamp": {"baseRevision": f.base, "localStep": f.step}}


count = 0


def emit(n=1):
    global count
    count += n


commutativity, replay, associativity = [], [], []
for a, b in product(domain, repeat=2):
    assert merge(a, b) == merge(b, a)
    commutativity.append([index[a], index[b], index[merge(a, b)]])
    assert merge(merge(a, b), b) == merge(a, b)
    replay.append([index[a], index[b], index[merge(a, b)]])
    emit(2)
for a, b, c in product(domain, repeat=3):
    expected = merge(merge(a, b), c)
    assert expected == merge(a, merge(b, c))
    associativity.append([index[a], index[b], index[c], index[expected]])
    emit()
self_idem, observed, advance = [], [], []
for a in domain:
    self_idem.append([index[a], index[merge(a, a)]])
    newer = edit(a, a.base, not a.enabled)
    assert merge(a, newer) == newer
    observed.append({"prior": index[a], "acknowledgedRevision": a.base,
                     "requested": not a.enabled, "edited": js(newer),
                     "merged": js(merge(a, newer))})
    adv = edit(a, a.base + 1, not a.enabled)
    assert merge(a, adv).enabled != a.enabled
    advance.append({"prior": index[a], "acknowledgedRevision": a.base + 1,
                    "requested": not a.enabled, "edited": js(adv),
                    "mergedValue": merge(a, adv).enabled})
    emit(3)

CLIENTS = ["ts", "swift"]
ALL = ["ts", "swift", "server"]
cases = []


def case(**kw):
    cases.append(kw)
    emit()


case(id="off-exact-tie", check="Off exact tie", kind="merge", runners=ALL,
     left=js(Field(4, 2, True)), right=js(Field(4, 2, False)),
     expected=js(merge(Field(4, 2, True), Field(4, 2, False))))
initial = {"a": Field(2, 0, False), "b": Field(2, 0, False)}
canon = ref["canonical_fields"]
after = canon(canon(initial, {"a": Field(2, 1, True)}), {"b": Field(2, 1, True)})
alias = {"a": "globalOn", "b": "services.youtube"}
case(id="independent-offline-fields", check="independent offline fields survive",
     kind="fields", runners=ALL,
     initial={alias[k]: js(v) for k, v in initial.items()},
     changes=[{"globalOn": js(Field(2, 1, True))}, {"services.youtube": js(Field(2, 1, True))}],
     expected={alias[k]: js(v) for k, v in after.items()})
older, newer = Field(4, 1, True), Field(4, 2, False)
case(id="older-echo-retains-later-intent", check="older echo retains later local intent",
     kind="pending", runners=CLIENTS, pending=js(newer), canonical=js(older),
     expected=js(pending_after_ack(newer, older)))
assert pending_after_ack(newer, Field(5, 1, True)) is None
case(id="observed-newer-account-wins", check="observed newer account ordering wins",
     kind="pending", runners=CLIENTS, pending=js(newer), canonical=js(Field(5, 1, True)),
     expected=None)
bad = [("negative-base", Field(-1, 1, True)), ("fractional-base", Field(1.5, 1, True)),
       ("boolean-base", Field(True, 1, True)), ("unsafe-base", Field(MAX_SAFE + 1, 1, True)),
       ("negative-step", Field(1, -1, True)), ("step-overflow", Field(1, MAX_STEP + 1, True)),
       ("string-value", Field(1, 1, "on"))]
for name, f in bad:
    assert not ref["valid"](f)
    case(id=f"invalid-{name}", check="invalid metadata rejected", kind="invalid",
         runners=ALL, field=js(f), expected="rejected")
eligible = ref["eligible"]
assert not eligible(Field(20, 1, True), 10, 30)
case(id="future-body-base", check="future body base cannot replace actual anchor",
     kind="admission", runners=["server"], operation=js(Field(20, 1, True)),
     receiptRevision=10, serverRevisions=[30],
     expected=[{"status": "rejected", "reason": "operation-base"}])
assert not eligible(Field(10, 1, True), 10, 9)
case(id="receipt-future-to-server", check="future relative to server rejected",
     kind="admission", runners=["server"], operation=js(Field(10, 1, True)),
     receiptRevision=10, serverRevisions=[9],
     expected=[{"status": "rejected", "reason": "receipt"}])
case(id="saturation-holds", check="counter saturation pauses rather than wraps",
     kind="edit", runners=CLIENTS, prior=js(Field(4, MAX_STEP, True)),
     acknowledgedRevision=4, requested=False,
     expected={"status": "hold", "field": js(Field(4, MAX_STEP, True)), "requestedValue": False})
rec = edit(Field(4, MAX_STEP, True), 5, False)
case(id="trusted-ack-recovers-saturation", check="new trusted ack recovers exhausted counter",
     kind="edit", runners=CLIENTS, prior=js(Field(4, MAX_STEP, True)),
     acknowledgedRevision=5, requested=False,
     expected={"status": "edited", "field": js(rec)})
case(id="pristine-explicit-edit", check="explicit pristine edit beats untouched default",
     kind="merge", runners=ALL, left=js(Field(0, 0, True)), right=js(Field(0, 1, False)),
     expected=js(merge(Field(0, 0, True), Field(0, 1, False))))
case(id="numeric-ceiling-forgery", check="numeric version check alone admits previously future request later",
     kind="admission", runners=["server"], operation=js(Field(20, 1, True)),
     receiptRevision=10, serverRevisions=[10, 30],
     expected=[{"status": "rejected", "reason": "operation-base"}] * 2)
case(id="no-receive-time-rebasing", check="receive-time clamp manufactures newer priority",
     kind="replay", runners=["server"], stored=js(Field(4, 0, True)), serverRevision=4,
     operation=js(Field(4, 1, False)), receivedAt=[1000, 2000],
     expected={"field": js(Field(4, 1, False)), "settingsVersion": 5})

key = bytes(range(32))
S1, L2 = ref["synthetic_subject"], ref["synthetic_lineage"]
L3, S4 = "00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000004"


def mac(subject, lineage, revision):
    raw = hmac.digest(key, ref["anchor_bytes"](subject, lineage, revision), hashlib.sha256)
    assert raw == ref["issue_anchor"](subject, lineage, revision)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


mac10 = mac(S1, L2, 10)


def anchor(id, check, state, receipt, expected):
    case(id=id, check=check, kind="anchor", runners=["server"], state=state,
         receipt=receipt, expected=expected)


anchor("anchor-valid", "valid original anchor", {"subject": S1, "lineage": L2, "revision": 10},
       {"version": 1, "lineage": L2, "revision": 10, "mac": mac10}, "accepted")
anchor("anchor-forged-future", "cannot forge future original anchor",
       {"subject": S1, "lineage": L2, "revision": 20},
       {"version": 1, "lineage": L2, "revision": 20, "mac": mac10}, "rejected")
anchor("anchor-forged-future-after-advance", "future forgery still invalid after server advances",
       {"subject": S1, "lineage": L2, "revision": 30},
       {"version": 1, "lineage": L2, "revision": 20, "mac": mac10}, "rejected")
anchor("anchor-lineage-isolation", "lineage isolation", {"subject": S1, "lineage": L3, "revision": 10},
       {"version": 1, "lineage": L3, "revision": 10, "mac": mac10}, "rejected")
anchor("anchor-account-isolation", "account isolation", {"subject": S4, "lineage": L2, "revision": 10},
       {"version": 1, "lineage": L2, "revision": 10, "mac": mac10}, "rejected")
anchor("anchor-wrong-mac", "wrong MAC rejected", {"subject": S1, "lineage": L2, "revision": 10},
       {"version": 1, "lineage": L2, "revision": 10,
        "mac": base64.urlsafe_b64encode(bytes(32)).decode().rstrip("=")}, "rejected")

assert count == 6558 == ref["checks"], count
assert len(cases) == 24
ids = [c["id"] for c in cases]
assert len(set(ids)) == len(ids)

model = open(MODEL_PATH, "rb").read()
out = {
    "description": (
        "Shared settings field-order reference vectors: one explicit vector per assertion of the "
        "pure ordering reference model (6,558). Consumed by core vitest, StillKit XCTest and the "
        "Deno sync server tests. Each vector lists the runners that can execute it; generated by "
        "scripts/sync-vectors/generate.py from scripts/sync-vectors/reference.py, do not hand-edit "
        "expected outcomes."
    ),
    "referenceModelSha256": hashlib.sha256(model).hexdigest(),
    "referenceAssertions": 6558,
    "counts": {
        "commutativity": len(commutativity), "replayIdempotence": len(replay),
        "associativity": len(associativity), "selfIdempotence": len(self_idem),
        "observedEdit": len(observed), "acknowledgementAdvance": len(advance), "cases": len(cases),
    },
    "syntheticAnchorKeyHex": key.hex(),
    "domain": [js(f) for f in domain],
    "algebra": {
        "runners": ALL,
        "commutativity": commutativity, "replayIdempotence": replay,
        "associativity": associativity, "selfIdempotence": self_idem,
        "observedEdit": observed, "acknowledgementAdvance": advance,
    },
    "cases": cases,
}
assert sum(out["counts"].values()) == 6558


def dump(value, indent=0):
    """Readable JSON with one vector per line for the large index tables."""
    pad = "  " * indent
    if isinstance(value, dict):
        items = [f'{pad}  {json.dumps(k)}: {dump(v, indent + 1)}' for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list) and value and all(isinstance(v, list) for v in value):
        rows = [f"{pad}  {json.dumps(v, separators=(',', ':'))}" for v in value]
        return "[\n" + ",\n".join(rows) + f"\n{pad}]"
    if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
        rows = [f"{pad}  {json.dumps(v, separators=(', ', ': '))}" for v in value]
        return "[\n" + ",\n".join(rows) + f"\n{pad}]"
    return json.dumps(value, separators=(", ", ": "))


text = dump(out) + "\n"
assert json.loads(text) == out
if OUT_PATH is None:
    sys.stdout.write(text)
else:
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w") as handle:
        handle.write(text)
    os.replace(tmp, OUT_PATH)
print(json.dumps({"vectors": count, "cases": len(cases)}), file=sys.stderr)
