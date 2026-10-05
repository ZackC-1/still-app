// Executes the shared invitation vectors against the TS ledger. StillKit's InvitationLedgerTests
// runs the same file with the same defaults, so TS and Swift must agree on every step and on the
// full final ledger of every scenario.
import {
  adoptInvitationAnchor, createInvitationLedger, PROPOSED_INVITATION_PARAMETERS, recordInvitationDirectControl,
  recordInvitationOpening, recordInvitationPurchase,
  type InvitationLedger, type InvitationOwnerParameters,
} from "../ledger.js";
import { arbitrateInvitation, commitInvitation, releaseInvitation, reserveInvitation, type InvitationContext } from "../arbiter.js";

export interface VectorScenario {
  name: string;
  parameters?: InvitationOwnerParameters;
  steps: any[];
  final?: InvitationLedger;
}

function context(step: any): InvitationContext {
  return {
    opening: step.opening, nowMs: step.nowMs,
    syncApplicable: step.syncApplicable ?? true, linkApplicable: step.linkApplicable ?? true, suppressed: step.suppressed ?? null,
  };
}

/** Returns the final ledger and a description of every step whose outcome differed. */
export function runScenario(scenario: VectorScenario): { ledger: InvitationLedger | null; failures: string[] } {
  const parameters = scenario.parameters ?? PROPOSED_INVITATION_PARAMETERS;
  const failures: string[] = [];
  let ledger: InvitationLedger | null = null;
  const fail = (index: number, step: any, actual: unknown) =>
    failures.push(`${scenario.name} step ${index} ${step.op}: expected ${JSON.stringify(step.expect ?? step.ledger)} got ${JSON.stringify(actual)}`);
  scenario.steps.forEach((step, index) => {
    if (step.op === "create") { ledger = createInvitationLedger(step.installation, step.anchorMs); return; }
    if (!ledger) { failures.push(`${scenario.name} step ${index}: no ledger`); return; }
    const l: InvitationLedger = ledger;
    switch (step.op) {
      case "open": ledger = recordInvitationOpening(l, step); break;
      case "control": ledger = recordInvitationDirectControl(l, step, parameters); break;
      case "purchase": ledger = recordInvitationPurchase(l, step); break;
      case "adoptAnchor": ledger = adoptInvitationAnchor(l, step.anchorMs); break;
      case "arbitrate": {
        const actual = arbitrateInvitation(l, context(step), parameters);
        if (actual.kind !== step.expect.kind || actual.reason !== step.expect.reason) fail(index, step, actual);
        break;
      }
      case "reserve": {
        const r = reserveInvitation(l, step.kind, context(step), parameters);
        const actual = r.ok ? { ok: true, generation: r.reservation.generation } : { ok: false, reason: r.reason };
        if (JSON.stringify(actual) !== JSON.stringify(step.expect)) fail(index, step, actual);
        if (r.ok) ledger = r.ledger;
        break;
      }
      case "commit": case "release": {
        const reservation = { kind: step.kind, opening: step.opening, generation: step.generation };
        const next = step.op === "commit" ? commitInvitation(l, reservation, step.nowMs) : releaseInvitation(l, reservation);
        if ((next !== null) !== step.expect.ok) fail(index, step, { ok: next !== null });
        if (next) ledger = next;
        break;
      }
      case "check": {
        const actual = Object.fromEntries(Object.keys(step.ledger).map(k => [k, (l as any)[k]]));
        if (JSON.stringify(actual) !== JSON.stringify(step.ledger)) fail(index, step, actual);
        break;
      }
      default: failures.push(`${scenario.name} step ${index}: unknown op ${step.op}`);
    }
  });
  return { ledger, failures };
}
