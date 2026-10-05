"""Synthetic reference model only; never imported by Still or connected to a service."""
from dataclasses import dataclass
from itertools import product
import json
import hashlib
import hmac

MAX_SAFE = 9_007_199_254_740_991
MAX_STEP = 1_048_575


@dataclass(frozen=True)
class Field:
    base: int
    step: int
    enabled: bool


def valid(field):
    return (
        type(field.base) is int and 0 <= field.base <= MAX_SAFE
        and type(field.step) is int and 0 <= field.step <= MAX_STEP
        and type(field.enabled) is bool
    )


def merge(left, right):
    assert valid(left) and valid(right)
    if (left.base, left.step) == (right.base, right.step):
        return Field(left.base, left.step, left.enabled and right.enabled)
    return max((left, right), key=lambda x: (x.base, x.step))


def edit(prior, acknowledged_revision, enabled):
    assert valid(prior)
    assert type(acknowledged_revision) is int
    assert prior.base <= acknowledged_revision <= MAX_SAFE
    if acknowledged_revision > prior.base:
        return Field(acknowledged_revision, 1, enabled)
    if prior.step == MAX_STEP:
        raise OverflowError('Refresh trusted acknowledgement; keep local choice without wrapping')
    return Field(prior.base, prior.step + 1, enabled)


def eligible(field, acknowledged_revision, server_revision):
    """Acknowledged revision is a TRUSTED input, not a body claim by a client."""
    return (
        valid(field)
        and field.step > 0
        and type(acknowledged_revision) is int
        and field.base == acknowledged_revision
        and acknowledged_revision <= server_revision
    )


def canonical_fields(state, changes):
    return {key: merge(value, changes.get(key, value)) for key, value in state.items()}


def pending_after_ack(pending, canonical):
    if pending is None:
        return None
    return pending if merge(pending, canonical) == pending and pending != canonical else None


checks = 0


def check(condition, name):
    global checks
    checks += 1
    if not condition:
        raise AssertionError(name)


domain = [Field(base, step, enabled) for base, step, enabled in product(range(3), range(3), (False, True))]
for a, b in product(domain, repeat=2):
    check(merge(a, b) == merge(b, a), 'commutativity')
    check(merge(merge(a, b), b) == merge(a, b), 'replay idempotence')
for a, b, c in product(domain, repeat=3):
    check(merge(merge(a, b), c) == merge(a, merge(b, c)), 'associativity')
for a in domain:
    check(merge(a, a) == a, 'self idempotence')
    newer = edit(a, a.base, not a.enabled)
    check(merge(a, newer) == newer, 'observed edit beats prior without a wall clock')
    check(merge(a, edit(a, a.base + 1, not a.enabled)).enabled != a.enabled, 'ack advances causal base')

check(merge(Field(4, 2, True), Field(4, 2, False)).enabled is False, 'Off exact tie')
initial = {'a': Field(2, 0, False), 'b': Field(2, 0, False)}
result = canonical_fields(canonical_fields(initial, {'a': Field(2, 1, True)}), {'b': Field(2, 1, True)})
check(result['a'].enabled and result['b'].enabled, 'independent offline fields survive')
older = Field(4, 1, True)
newer = Field(4, 2, False)
check(pending_after_ack(newer, older) == newer, 'older echo retains later local intent')
check(pending_after_ack(newer, Field(5, 1, True)) is None, 'observed newer account ordering wins')
for bad in [Field(-1, 1, True), Field(1.5, 1, True), Field(True, 1, True), Field(MAX_SAFE + 1, 1, True), Field(1, -1, True), Field(1, MAX_STEP + 1, True), Field(1, 1, 'on')]:
    check(not valid(bad), 'invalid metadata rejected')
check(not eligible(Field(20, 1, True), 10, 30), 'future body base cannot replace actual anchor')
check(not eligible(Field(10, 1, True), 10, 9), 'future relative to server rejected')
try:
    edit(Field(4, MAX_STEP, True), 4, False)
except OverflowError:
    check(True, 'counter saturation pauses rather than wraps')
else:
    check(False, 'counter saturation must not wrap')
check(edit(Field(4, MAX_STEP, True), 5, False) == Field(5, 1, False), 'new trusted ack recovers exhausted counter')
check(merge(Field(0, 0, True), Field(0, 1, False)).enabled is False, 'explicit pristine edit beats untouched default')

# Counterexample: a field's invalid claimed future base passes later if admission
# checks ONLY the current revision, without evidence of the original anchor.
forged = Field(20, 1, True)
naive_before = valid(forged) and forged.base <= 10
naive_later = valid(forged) and forged.base <= 30
check(not naive_before and naive_later, 'numeric version check alone admits previously future request later')

# Counterexample: a receipt-time clamp is not immutable on replay.
claimed_time = 1_000_000
first_normalized = min(claimed_time, 1_000 + 300_000)
replayed_normalized = min(claimed_time, 2_000 + 300_000)
check(replayed_normalized > first_normalized, 'receive-time clamp manufactures newer priority')

# A server-issued settings-only anchor prevents a forged future revision from
# becoming valid when the real revision catches up. Synthetic key/subjects only.
synthetic_key = bytes(range(32))
synthetic_subject = '00000000-0000-0000-0000-000000000001'
synthetic_lineage = '00000000-0000-0000-0000-000000000002'


def anchor_bytes(subject, lineage, revision):
    assert type(revision) is int and 0 <= revision <= MAX_SAFE
    return f'still-settings-anchor-v1\n{subject}\n{lineage}\n{revision}'.encode('ascii')


def issue_anchor(subject, lineage, revision):
    return hmac.digest(synthetic_key, anchor_bytes(subject, lineage, revision), hashlib.sha256)


def verify_anchor(subject, lineage, revision, mac):
    return hmac.compare_digest(issue_anchor(subject, lineage, revision), mac)


anchor = issue_anchor(synthetic_subject, synthetic_lineage, 10)
check(verify_anchor(synthetic_subject, synthetic_lineage, 10, anchor), 'valid original anchor')
check(not verify_anchor(synthetic_subject, synthetic_lineage, 20, anchor), 'cannot forge future original anchor')
check(not verify_anchor(synthetic_subject, synthetic_lineage, 20, anchor), 'future forgery still invalid after server advances')
check(not verify_anchor(synthetic_subject, '00000000-0000-0000-0000-000000000003', 10, anchor), 'lineage isolation')
check(not verify_anchor('00000000-0000-0000-0000-000000000004', synthetic_lineage, 10, anchor), 'account isolation')
check(not verify_anchor(synthetic_subject, synthetic_lineage, 10, bytes(32)), 'wrong MAC rejected')

print(json.dumps({
    'status': 'PASS', 'synthetic_assertions': checks,
    'canonical_domain_fields': len(domain),
    'counterexamples_confirmed': ['receive-time clamp changes replay priority', 'numeric revision ceiling cannot authenticate an original anchor'],
    'anchor_proof_model': 'Synthetic HMAC-SHA256 binds purpose/account/lineage/revision; no real key or provider',
    'limits': ['Pure Python reference model only', 'Anchor proof here is a synthetic model, not a server function', 'No TS/Swift/SQL integration or production/device/provider verification', 'Candidate does not establish real-time order of disconnected same-key edits'],
}, indent=2))
