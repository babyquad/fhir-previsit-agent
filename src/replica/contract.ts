/**
 * The replica contract, version 1. Shared by the FHIR half (this repo) and the
 * screen half (a separate repo).
 *
 * Two documents cross the boundary:
 *
 *   Trace      one observed case: what a worker looked at (targets only, never
 *              values), what they decided, and the derived features of the case.
 *              Either surface can produce one.
 *   Procedure  the decision logic learned from many traces. It names features,
 *              not screens or endpoints, so a procedure learned from FHIR
 *              observations can run over a screen, and the other way round.
 *
 * Features are the bridge: each has a FHIR source (implemented here) and a
 * screen source (implemented by the screen half). Same name, same meaning.
 */

import { z } from "zod";

// ---------- actions ----------

export const ACTIONS = [
  "COLLECT_INSURANCE",
  "CONFIRM_OR_SELF_PAY",
  "REQUEST_NEW_CARD",
  "CONFIRM_PRIMARY",
  "GET_REFERRAL",
  "REMIND_AT_CHECKIN",
  "NO_ACTION",
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;

/** What the replica does when it should not act alone. Never appears in a human trace. */
export const ESCALATE = "ESCALATE" as const;

export const ACTION_TEXT: Record<Action, string> = {
  COLLECT_INSURANCE: "No insurance on file: collect insurance details or start the self-pay conversation.",
  CONFIRM_OR_SELF_PAY: "Coverage on file is not active: confirm current insurance or discuss self-pay.",
  REQUEST_NEW_CARD: "Coverage ends before the visit: ask for the current insurance card.",
  CONFIRM_PRIMARY: "More than one active policy: confirm which one is primary.",
  GET_REFERRAL: "HMO plan and a specialist-type visit with no referral on file: request the referral.",
  REMIND_AT_CHECKIN: "Coverage ends soon after the visit: remind the patient at check-in.",
  NO_ACTION: "No action needed.",
};

// ---------- features ----------

export type FeatureType = "bool" | "number" | "category";
export type FeatureValue = boolean | number | string | null;

export type FeatureSpec = {
  name: string;
  type: FeatureType;
  meaning: string;
  /** Where the FHIR half reads it. Also the attention targets: a feature counts as "looked at" when any of these was read. */
  fhir: string[];
  /** Suggested screen source, for the screen half to bind. */
  screen: string;
};

export const FEATURES: FeatureSpec[] = [
  { name: "coverage_on_file", type: "bool", meaning: "Any insurance policy is on file.", fhir: ["Coverage?"], screen: "Chart > Insurance tab: any policy row" },
  { name: "active_coverage", type: "bool", meaning: "At least one policy has status active.", fhir: ["Coverage.status"], screen: "Insurance tab: Status column" },
  {
    name: "days_covered_after_visit",
    type: "number",
    meaning: "Days between the visit and the end of the best active policy. Negative = ends before the visit. Missing = no end date or no active policy.",
    fhir: ["Coverage.period"],
    screen: "Insurance tab: Effective / Term date columns, compared with the appointment date",
  },
  { name: "active_policies_on_visit", type: "number", meaning: "How many active policies cover the visit date.", fhir: ["Coverage.period", "Coverage.status"], screen: "Insurance tab: count of active rows covering the visit date" },
  { name: "plan_type", type: "category", meaning: "Plan type of the best active policy (HMO, PPO, MEDICARE_ADV, ...).", fhir: ["Coverage.type"], screen: "Insurance tab: Plan Type column" },
  { name: "visit_type", type: "category", meaning: "Kind of visit (wellness, new_patient, follow_up, specialist, pre_op, imaging).", fhir: ["Appointment.serviceType"], screen: "Appointment detail: Visit Type" },
  { name: "referral_on_file", type: "bool", meaning: "An active referral is on file for the patient.", fhir: ["ServiceRequest?"], screen: "Chart > Referrals tab: any active row" },
  { name: "patient_age", type: "number", meaning: "Age on the visit date.", fhir: ["Patient.birthDate"], screen: "Chart header: DOB" },
  { name: "visit_weekday", type: "category", meaning: "Day of week of the visit.", fhir: ["Appointment.start"], screen: "Appointment detail: date" },
  { name: "home_region", type: "category", meaning: "Region of the home address.", fhir: ["Patient.address"], screen: "Chart > Demographics: address" },
];
export const featureByName = new Map(FEATURES.map((f) => [f.name, f]));

const featureValue = z.union([z.boolean(), z.number(), z.string(), z.null()]);

// ---------- trace ----------

export const TraceEvent = z.object({
  /** Milliseconds since the case was opened. */
  t_ms: z.number().int().nonnegative(),
  kind: z.enum(["read", "view", "click", "type", "navigate", "write"]),
  /** WHAT was touched: a FHIR path like "Coverage.period" or a screen locator. Never a value. */
  target: z.string().min(1).max(200),
});
export type TraceEvent = z.infer<typeof TraceEvent>;

export const Trace = z.object({
  schema: z.literal("replica.trace/v1"),
  case_id: z.string(),
  worker_id: z.string(),
  surface: z.enum(["fhir", "screen"]),
  /** ISO date the work happened, used to slice observation by week. */
  observed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  duration_ms: z.number().nonnegative(),
  events: z.array(TraceEvent),
  decision: z.object({ action: Action, note: z.string().max(300).optional() }),
  /** Derived case features at decision time. No names, ids, dates of birth or member ids. */
  features: z.record(featureValue),
});
export type Trace = z.infer<typeof Trace>;

// ---------- procedure ----------

export const Condition = z.object({
  feature: z.string(),
  op: z.enum(["eq", "in", "le", "missing"]),
  value: z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]).optional(),
  /** true means the opposite branch: NOT (feature op value). */
  negate: z.boolean().default(false),
});
export type Condition = z.infer<typeof Condition>;

export const Rule = z.object({
  id: z.string(),
  when: z.array(Condition),
  action: Action,
  /** Observed cases that landed here. */
  support: z.number().int(),
  /** Share of those cases where the worker chose `action`. */
  agreement: z.number().min(0).max(1),
  /** Up to five case ids, so a reviewer can pull the original observations. */
  examples: z.array(z.string()),
  /**
   * Combinations never observed under this rule: a case that matches this rule
   * AND all of `extras` also looks like rule `with`, which decides differently.
   * The replica escalates those instead of guessing which one wins.
   */
  conflicts: z.array(z.object({ with: z.string(), extras: z.array(Condition) })).default([]),
});
export type Rule = z.infer<typeof Rule>;

export const FeatureDomain = z.object({
  name: z.string(),
  type: z.enum(["bool", "number", "category"]),
  values: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Share of traces in which the worker looked at this feature's source. */
  attention: z.number().min(0).max(1),
});

export const Procedure = z.object({
  schema: z.literal("replica.procedure/v1"),
  task: z.string(),
  learned_from: z.object({
    traces: z.number().int(),
    workers: z.array(z.string()),
    surfaces: z.array(z.string()),
    first_day: z.string(),
    last_day: z.string(),
  }),
  /** Features the learner was allowed to use: the ones the worker actually looked at. */
  domains: z.array(FeatureDomain),
  /** Features available but excluded because the worker never looked at them. */
  ignored: z.array(z.string()),
  rules: z.array(Rule),
  abstain: z.object({ min_support: z.number().int(), min_agreement: z.number() }),
  /** Median minutes the worker spent per case, from the traces. */
  human_minutes_per_case: z.number(),
});
export type Procedure = z.infer<typeof Procedure>;

// ---------- rendering ----------

export function renderCondition(c: Condition): string {
  const spec = featureByName.get(c.feature);
  const int = spec?.type === "number";
  if (c.op === "missing") return c.negate ? `${c.feature} is present` : `${c.feature} is missing`;
  if (c.op === "le") {
    const v = int && typeof c.value === "number" ? Math.floor(c.value) : c.value;
    return c.negate ? `${c.feature} > ${v} (or missing)` : `${c.feature} <= ${v}`;
  }
  if (c.op === "in") {
    const set = (c.value as string[]).join(", ");
    return c.negate ? `${c.feature} is not one of {${set}}` : `${c.feature} is one of {${set}}`;
  }
  if (typeof c.value === "boolean") return `${c.feature} is ${c.negate ? !c.value : c.value}`;
  return c.negate ? `${c.feature} is not ${c.value}` : `${c.feature} is ${c.value}`;
}

export function renderRule(r: Rule): string {
  const when = r.when.length ? r.when.map(renderCondition).join(" AND ") : "always";
  return `${r.id}: IF ${when} THEN ${r.action}  (${r.support} cases, ${(r.agreement * 100).toFixed(0)}% agreement)`;
}
