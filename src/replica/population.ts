/**
 * Synthetic clinic population for the replica demo.
 *
 * Generates patients, appointments, coverages and referrals as FHIR R4
 * resources, with a seeded random generator so every run is reproducible.
 * The case mix is weighted so each kind of situation a front-desk worker
 * meets shows up often enough to learn from. All data is invented.
 */

import type { Resource } from "../fhir";

export const REPLICA_TAG = { system: "https://ragflo.com/fhir-demo", code: "replica-demo" };
export const REPLICA_TAG_PARAM = `${REPLICA_TAG.system}|${REPLICA_TAG.code}`;
const ID_SYSTEM = "https://ragflo.com/fhir-demo/replica-id";
const PLAN_TYPE_SYSTEM = "https://ragflo.com/fhir-demo/plan-type";
const VISIT_TYPE_SYSTEM = "https://ragflo.com/fhir-demo/visit-type";

export const TRAINING_PLAN_TYPES = ["HMO", "PPO", "MEDICARE_ADV"] as const;
export const VISIT_TYPES = ["wellness", "new_patient", "follow_up", "specialist", "pre_op", "imaging"] as const;
export const SPECIALIST_LIKE = new Set(["specialist", "pre_op", "imaging"]);
const PAYERS: Record<string, string[]> = {
  HMO: ["Demo Health Plan B", "Northside HMO (demo)"],
  PPO: ["Demo Health Plan A", "Lakeview PPO (demo)"],
  MEDICARE_ADV: ["Demo Medicare Advantage"],
  MEDICAID: ["Demo State Medicaid"],
};
const REGIONS = ["north", "south", "east", "west"];
const GIVEN = ["Ana", "Ben", "Carla", "Dev", "Elena", "Femi", "Grace", "Hugo", "Iris", "Jon", "Kemi", "Luis", "Mina", "Noah", "Omar", "Pia", "Quinn", "Rosa", "Sam", "Tara"];
const FAMILY = ["Abara", "Brooks", "Castillo", "Dunn", "Esposito", "Fischer", "Greene", "Hale", "Ibarra", "Jensen", "Kowalski", "Lam", "Moreno", "Nakamura", "Osei", "Patel"];

export type Scenario =
  | "no_coverage" | "cancelled" | "lapsed" | "dual" | "hmo_specialist_no_referral"
  | "hmo_specialist_referral" | "ending_soon" | "near_miss" | "clean";

const MIX: [Scenario, number][] = [
  ["no_coverage", 10], ["cancelled", 10], ["lapsed", 12], ["dual", 10], ["hmo_specialist_no_referral", 12],
  ["hmo_specialist_referral", 8], ["ending_soon", 12], ["near_miss", 8], ["clean", 18],
];

export type CaseSpec = {
  key: string;
  scenario: Scenario | "novel";
  visitDate: string;
  visitType: string;
  age: number;
  region: string;
  referral: boolean;
  coverages: { status: string; planType: string; startOffset: number; endOffset?: number }[];
};

export type Case = { caseId: string; appointmentId: string; patientId: string; visitDate: string; spec: CaseSpec };

// ---------- seeded randomness ----------

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const weighted = <T>(xs: [T, number][]): T => {
    let r = next() * xs.reduce((s, [, w]) => s + w, 0);
    for (const [x, w] of xs) if ((r -= w) < 0) return x;
    return xs.at(-1)![0];
  };
  return { next, int, pick, weighted };
}

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Weekdays only: the front desk works Monday to Friday. */
export function workdays(firstMonday: string, weeks: number): string[] {
  const out: string[] = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 5; d++) out.push(addDays(firstMonday, w * 7 + d));
  return out;
}

// ---------- case generation ----------

export function makeSpec(r: ReturnType<typeof rng>, key: string, visitDate: string, scenario: Scenario): CaseSpec {
  const base: CaseSpec = {
    key, scenario, visitDate,
    visitType: r.pick(VISIT_TYPES),
    age: r.int(19, 88),
    region: r.pick(REGIONS),
    referral: r.next() < 0.3,
    coverages: [],
  };
  const plan = () => r.pick(TRAINING_PLAN_TYPES);
  const longEnd = () => (r.next() < 0.3 ? undefined : r.int(31, 330));
  const nonHmoOrRoutine = (c: CaseSpec) => {
    // keep the HMO + specialist + no referral situation for its own scenario
    if (c.coverages.some((x) => x.planType === "HMO") && SPECIALIST_LIKE.has(c.visitType)) c.referral = true;
  };

  switch (scenario) {
    case "no_coverage":
      break;
    case "cancelled":
      base.coverages = [{ status: "cancelled", planType: plan(), startOffset: -r.int(200, 700), endOffset: r.next() < 0.5 ? undefined : r.int(-100, 200) }];
      break;
    case "lapsed":
      base.coverages = [{ status: "active", planType: plan(), startOffset: -r.int(200, 700), endOffset: -r.int(1, 60) }];
      break;
    case "dual":
      base.coverages = [
        { status: "active", planType: plan(), startOffset: -r.int(30, 400), endOffset: longEnd() },
        { status: "active", planType: plan(), startOffset: -r.int(5, 200), endOffset: longEnd() },
      ];
      break;
    case "hmo_specialist_no_referral":
      base.visitType = r.pick(["specialist", "pre_op", "imaging"]);
      base.referral = false;
      base.coverages = [{ status: "active", planType: "HMO", startOffset: -r.int(30, 400), endOffset: longEnd() }];
      break;
    case "hmo_specialist_referral":
      base.visitType = r.pick(["specialist", "pre_op", "imaging"]);
      base.referral = true;
      base.coverages = [{ status: "active", planType: "HMO", startOffset: -r.int(30, 400), endOffset: longEnd() }];
      break;
    case "ending_soon":
      base.coverages = [{ status: "active", planType: plan(), startOffset: -r.int(100, 360), endOffset: r.int(0, 14) }];
      nonHmoOrRoutine(base);
      break;
    case "near_miss":
      base.coverages = [{ status: "active", planType: plan(), startOffset: -r.int(100, 360), endOffset: r.int(15, 30) }];
      nonHmoOrRoutine(base);
      break;
    case "clean":
      base.coverages = [{ status: "active", planType: plan(), startOffset: -r.int(30, 400), endOffset: longEnd() }];
      nonHmoOrRoutine(base);
      break;
  }
  return base;
}

/** `perDay` cases on each workday, ids prefixed so several populations can share one server. */
export function generatePopulation(opts: { seed: number; days: string[]; perDay: number; prefix: string }): CaseSpec[] {
  const r = rng(opts.seed);
  const specs: CaseSpec[] = [];
  for (const day of opts.days) {
    for (let i = 0; i < opts.perDay; i++) {
      specs.push(makeSpec(r, `${opts.prefix}-${specs.length + 1}`, day, r.weighted(MIX)));
    }
  }
  return specs;
}

// ---------- FHIR resources ----------

const meta = { tag: [REPLICA_TAG] };

export function toResources(specs: CaseSpec[], seed = 7): { resources: Resource[]; cases: Case[] } {
  const r = rng(seed);
  const resources: Resource[] = [];
  const cases: Case[] = [];

  for (const s of specs) {
    const patientId = `${s.key}-pt`;
    const appointmentId = `${s.key}-appt`;
    const birthYear = Number(s.visitDate.slice(0, 4)) - s.age;
    resources.push({
      resourceType: "Patient", id: patientId, meta,
      identifier: [{ system: ID_SYSTEM, value: patientId }],
      name: [{ given: [r.pick(GIVEN)], family: r.pick(FAMILY) }],
      birthDate: `${birthYear}-${s.visitDate.slice(5, 7)}-${s.visitDate.slice(8, 10)}`,
      address: [{ city: "Demo City", district: s.region }],
    });
    resources.push({
      resourceType: "Appointment", id: appointmentId, meta,
      identifier: [{ system: ID_SYSTEM, value: appointmentId }],
      status: "booked",
      serviceType: [{ coding: [{ system: VISIT_TYPE_SYSTEM, code: s.visitType }], text: s.visitType.replace("_", " ") }],
      start: `${s.visitDate}T14:00:00Z`,
      end: `${s.visitDate}T14:30:00Z`,
      participant: [{ actor: { reference: `Patient/${patientId}` }, status: "accepted" }],
    });
    s.coverages.forEach((c, i) => {
      const id = `${s.key}-cov${i + 1}`;
      resources.push({
        resourceType: "Coverage", id, meta,
        identifier: [{ system: ID_SYSTEM, value: id }],
        status: c.status,
        type: { coding: [{ system: PLAN_TYPE_SYSTEM, code: c.planType }], text: c.planType },
        beneficiary: { reference: `Patient/${patientId}` },
        payor: [{ display: r.pick(PAYERS[c.planType] ?? ["Demo Plan"]) }],
        subscriberId: `DEMO-${r.int(1000, 9999)}-${r.int(1000, 9999)}`,
        period: { start: addDays(s.visitDate, c.startOffset), ...(c.endOffset === undefined ? {} : { end: addDays(s.visitDate, c.endOffset) }) },
      });
    });
    if (s.referral) {
      const id = `${s.key}-ref`;
      resources.push({
        resourceType: "ServiceRequest", id, meta,
        identifier: [{ system: ID_SYSTEM, value: id }],
        status: "active", intent: "order",
        category: [{ text: "referral" }],
        code: { text: "Specialist referral" },
        subject: { reference: `Patient/${patientId}` },
        authoredOn: addDays(s.visitDate, -r.int(3, 60)),
      });
    }
    cases.push({ caseId: s.key, appointmentId, patientId, visitDate: s.visitDate, spec: s });
  }
  return { resources, cases };
}

/** A transaction Bundle with conditional PUTs, so seeding the live server is idempotent. */
export function toTransaction(resources: Resource[]) {
  return {
    resourceType: "Bundle" as const,
    type: "transaction",
    entry: resources.map((res) => ({
      resource: res,
      request: { method: "PUT", url: `${res.resourceType}/${res.id}` },
    })),
  };
}
