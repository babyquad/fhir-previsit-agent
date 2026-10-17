/**
 * How good is the replica, and when is it safe to let it work?
 *
 *   score()          agreement with the worker on held-out cases, counting
 *                    escalations separately (an escalation is not a wrong
 *                    answer, it is a handoff, but it is not labor saved).
 *   learningCurve()  the same score after 1, 2, 3... weeks of watching:
 *                    "how long do you have to observe before deploying?"
 *   gate()           the promotion rule from shadow mode to supervised work.
 *   laborEstimate()  people-hours the decided cases would have taken, from
 *                    the worker's own observed time per case. An estimate.
 */

import { ESCALATE, type Action, type Procedure, type Trace } from "./contract";
import { learn, type LearnOptions } from "./learn";
import { decide } from "./replica";

export type Score = {
  cases: number;
  decided: number;
  escalated: number;
  agreeOnDecided: number;
  agreementOnDecided: number;
  escalationRate: number;
  misses: { case_id: string; human: Action; replica: Action }[];
};

export function score(proc: Procedure, heldOut: Trace[]): Score {
  let decided = 0;
  let agree = 0;
  let escalated = 0;
  const misses: Score["misses"] = [];
  for (const t of heldOut) {
    const d = decide(proc, t.features);
    if (d.action === ESCALATE) {
      escalated++;
      continue;
    }
    decided++;
    if (d.action === t.decision.action) agree++;
    else misses.push({ case_id: t.case_id, human: t.decision.action, replica: d.action });
  }
  return {
    cases: heldOut.length,
    decided,
    escalated,
    agreeOnDecided: agree,
    agreementOnDecided: decided ? agree / decided : 0,
    escalationRate: heldOut.length ? escalated / heldOut.length : 0,
    misses,
  };
}

export const weekOf = (t: Trace, firstDay: string) => Math.floor((Date.parse(t.observed_on) - Date.parse(firstDay)) / (7 * 86_400_000));

export function learningCurve(train: Trace[], heldOut: Trace[], opts?: LearnOptions) {
  const first = [...train].sort((a, b) => a.observed_on.localeCompare(b.observed_on))[0]!.observed_on;
  const weeks = Math.max(...train.map((t) => weekOf(t, first))) + 1;
  return Array.from({ length: weeks }, (_, w) => {
    const seen = train.filter((t) => weekOf(t, first) <= w);
    const proc = learn(seen, opts);
    return { weeks: w + 1, traces: seen.length, rules: proc.rules.length, ...score(proc, heldOut) };
  });
}

export const GATE = { minAgreement: 0.95, maxEscalation: 0.15 };

export function gate(s: Score): { ready: boolean; why: string } {
  const a = `${(s.agreementOnDecided * 100).toFixed(1)}% agreement`;
  const e = `${(s.escalationRate * 100).toFixed(1)}% escalated`;
  if (s.agreementOnDecided >= GATE.minAgreement && s.escalationRate <= GATE.maxEscalation) {
    return { ready: true, why: `${a}, ${e}: ready for supervised work (it acts, a human reviews escalations and a daily sample)` };
  }
  return { ready: false, why: `${a}, ${e}: keep shadowing (bar is ${GATE.minAgreement * 100}% agreement, at most ${GATE.maxEscalation * 100}% escalated)` };
}

/** People-hours the replica's decided cases represent. Based on observed minutes per case; label it an estimate. */
export function laborEstimate(proc: Procedure, s: Score, casesPerWeek: number) {
  const autoShare = s.cases ? s.decided / s.cases : 0;
  const hoursPerWeek = (casesPerWeek * autoShare * proc.human_minutes_per_case) / 60;
  return { autoShare, minutesPerCase: proc.human_minutes_per_case, hoursPerWeek };
}
