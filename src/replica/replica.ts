/**
 * The replica: execute a learned Procedure on new cases.
 *
 * For each case it perceives the features, checks the case looks like what
 * it learned from, finds the one rule that applies, and either acts or
 * escalates. It escalates, rather than guessing, when:
 *   - a feature it relies on has a value never seen during observation
 *     (a plan type she never handled),
 *   - the case fits its rule but ALSO fits another rule that decides
 *     differently, in a combination never observed (which one wins is
 *     unknown, so it asks),
 *   - the matching rule is backed by too few observed cases, or she was
 *     inconsistent there.
 * Escalations carry the reason, so the human knows what to look at, and the
 * answer becomes a new observation.
 *
 * Writing is off by default. With `write: true` each decision is posted as a
 * FHIR Task (intent "proposal") for staff, never as a change to the patient's
 * record.
 */

import type { FhirClient } from "../fhir";
import { ACTION_TEXT, ESCALATE, type Action, type FeatureValue, type Procedure, type Rule } from "./contract";
import { perceive } from "./features";
import { holds } from "./learn";
import { REPLICA_TAG } from "./population";

export type Decision = { action: Action | typeof ESCALATE; rule: Rule | null; reason: string };

export function decide(proc: Procedure, f: Record<string, FeatureValue>): Decision {
  const used = new Set(proc.rules.flatMap((r) => r.when.map((c) => c.feature)));
  for (const d of proc.domains) {
    if (!used.has(d.name)) continue;
    const v = f[d.name] ?? null;
    if (d.type === "category" && v !== null && !d.values?.includes(String(v))) {
      return { action: ESCALATE, rule: null, reason: `${d.name} = ${v} was never seen in ${proc.learned_from.traces} observed cases` };
    }
  }

  const rule = proc.rules.find((r) => r.when.every((c) => holds(c, f[c.feature] ?? null)));
  if (!rule) return { action: ESCALATE, rule: null, reason: "no learned rule covers this case" };
  for (const c of rule.conflicts) {
    if (c.extras.every((x) => holds(x, f[x.feature] ?? null))) {
      const other = proc.rules.find((r) => r.id === c.with);
      return { action: ESCALATE, rule, reason: `fits ${rule.id} (${rule.action}) and also ${c.with} (${other?.action}); that combination was never observed` };
    }
  }
  if (rule.support < proc.abstain.min_support) {
    return { action: ESCALATE, rule, reason: `${rule.id} rests on only ${rule.support} observed cases` };
  }
  if (rule.agreement < proc.abstain.min_agreement) {
    return { action: ESCALATE, rule, reason: `the worker was inconsistent on ${rule.id} cases (${Math.round(rule.agreement * 100)}% agreement)` };
  }
  return { action: rule.action, rule, reason: rule.id };
}

export type RunItem = {
  appointmentId: string;
  patientName: string;
  visitDay: string;
  features: Record<string, FeatureValue>;
  decision: Decision;
  ms: number;
  taskId?: string;
};

export async function runReplica(
  fhir: FhirClient,
  proc: Procedure,
  appointmentIds: string[],
  opts: { write?: boolean } = {},
): Promise<RunItem[]> {
  const out: RunItem[] = [];
  for (const id of appointmentIds) {
    const started = performance.now();
    const p = await perceive(fhir, id);
    const decision = decide(proc, p.features);
    const item: RunItem = {
      appointmentId: id,
      patientName: p.display.patientName,
      visitDay: p.display.visitDay,
      features: p.features,
      decision,
      ms: Math.round(performance.now() - started),
    };
    if (opts.write && decision.action !== "NO_ACTION") {
      const escalated = decision.action === ESCALATE;
      const task = await fhir.create({
        resourceType: "Task",
        meta: { tag: [REPLICA_TAG] },
        status: "requested",
        intent: "proposal",
        priority: escalated ? "urgent" : "routine",
        code: { text: escalated ? "Needs human review" : decision.action },
        description: escalated ? `Replica escalated: ${decision.reason}` : ACTION_TEXT[decision.action as Action],
        focus: { reference: `Appointment/${id}` },
        for: { reference: p.display.patientRef },
        authoredOn: new Date().toISOString(),
      });
      item.taskId = task.id;
    }
    out.push(item);
  }
  return out;
}
