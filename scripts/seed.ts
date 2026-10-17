/**
 * Seed the FHIR server with a small SYNTHETIC clinic schedule.
 *
 *   bun run seed            (FHIR_BASE defaults to the public HAPI R4 sandbox)
 *
 * Everything here is invented. Each resource carries a business identifier
 * and the demo tag, and is written with a conditional update
 * (PUT Patient?identifier=...), so re-running updates in place instead of
 * duplicating. Dates are relative to today, so the schedule is always
 * "upcoming" whenever the demo runs. The public sandbox is wiped from time to
 * time; just run this again.
 *
 * Each patient is built to exercise one worklist outcome.
 */

import { DEMO_TAG, FhirClient, type Bundle, type Resource } from "../src/fhir";

const ID_SYSTEM = "https://ragflo.com/fhir-demo/id";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

type Seed = {
  key: string;
  given: string;
  family: string;
  birthDate: string;
  visits: { key: string; inDays: number; reason: string; status?: string }[];
  coverages: { key: string; status: string; payor: string; plan: string; start: number; end?: number; memberId: string }[];
  outcome: string;
};

const SEEDS: Seed[] = [
  {
    key: "P001", given: "Maria", family: "Alvarez", birthDate: "1958-03-14", outcome: "OK",
    visits: [{ key: "A001", inDays: 2, reason: "Annual wellness visit" }],
    coverages: [{ key: "C001", status: "active", payor: "Demo Health Plan A", plan: "Gold PPO", start: -200, end: 165, memberId: "DHA-0042-7781" }],
  },
  {
    key: "P002", given: "James", family: "Okafor", birthDate: "1971-11-02", outcome: "EXPIRES_BEFORE_VISIT",
    visits: [{ key: "A002", inDays: 6, reason: "Follow-up, hypertension" }],
    coverages: [{ key: "C002", status: "active", payor: "Demo Health Plan B", plan: "Silver HMO", start: -360, end: 3, memberId: "DHB-1189-3304" }],
  },
  {
    key: "P003", given: "Linda", family: "Chen", birthDate: "1989-07-21", outcome: "NO_COVERAGE_ON_FILE",
    visits: [{ key: "A003", inDays: 4, reason: "New patient visit" }],
    coverages: [],
  },
  {
    key: "P004", given: "Robert", family: "Haynes", birthDate: "1949-01-30", outcome: "NOT_ACTIVE",
    visits: [{ key: "A004", inDays: 9, reason: "Pre-op consult" }],
    coverages: [{ key: "C004", status: "cancelled", payor: "Demo Medicare Advantage", plan: "MA Plus", start: -500, memberId: "DMA-7730-0091" }],
  },
  {
    key: "P005", given: "Dorothy", family: "Price", birthDate: "1944-05-09", outcome: "OK (old plan lapsed, new plan active)",
    visits: [{ key: "A005", inDays: 11, reason: "Diabetes check" }],
    coverages: [
      { key: "C005a", status: "active", payor: "Demo Health Plan A", plan: "Bronze", start: -700, end: -30, memberId: "DHA-5521-0007" },
      { key: "C005b", status: "active", payor: "Demo Medicare Advantage", plan: "MA Basic", start: -29, memberId: "DMA-6604-2210" },
    ],
  },
  {
    key: "P006", given: "Maria", family: "Alvarado", birthDate: "1993-09-17", outcome: "excluded (visit cancelled); name collides with P001",
    visits: [{ key: "A006", inDays: 3, reason: "Physical therapy", status: "cancelled" }],
    coverages: [{ key: "C006", status: "active", payor: "Demo Health Plan B", plan: "Silver HMO", start: -90, end: 275, memberId: "DHB-3390-4418" }],
  },
  {
    key: "P007", given: "Samuel", family: "Rivera", birthDate: "1965-12-01", outcome: "outside a 14-day window",
    visits: [{ key: "A007", inDays: 20, reason: "Cardiology follow-up" }],
    coverages: [{ key: "C007", status: "active", payor: "Demo Health Plan A", plan: "Gold PPO", start: -100, end: 265, memberId: "DHA-9012-6650" }],
  },
];

const meta = { tag: [DEMO_TAG] };
const identifier = (value: string) => [{ system: ID_SYSTEM, value }];

function entry(resource: Resource, key: string, fullUrl: string) {
  return {
    fullUrl,
    resource,
    request: { method: "PUT", url: `${resource.resourceType}?identifier=${encodeURIComponent(`${ID_SYSTEM}|${key}`)}` },
  };
}

export function buildSeedBundle(): Bundle {
  const entries = SEEDS.flatMap((s) => {
    const patientUrl = `urn:uuid:${crypto.randomUUID()}`;
    const patient = entry(
      { resourceType: "Patient", meta, identifier: identifier(s.key), name: [{ given: [s.given], family: s.family }], birthDate: s.birthDate },
      s.key,
      patientUrl,
    );
    const visits = s.visits.map((v) => {
      const start = `${day(v.inDays)}T14:00:00Z`;
      const end = `${day(v.inDays)}T14:30:00Z`;
      return entry(
        {
          resourceType: "Appointment",
          meta,
          identifier: identifier(v.key),
          status: v.status ?? "booked",
          description: v.reason,
          start,
          end,
          participant: [{ actor: { reference: patientUrl }, status: "accepted" }],
        },
        v.key,
        `urn:uuid:${crypto.randomUUID()}`,
      );
    });
    const coverages = s.coverages.map((c) =>
      entry(
        {
          resourceType: "Coverage",
          meta,
          identifier: identifier(c.key),
          status: c.status,
          beneficiary: { reference: patientUrl },
          subscriberId: c.memberId,
          payor: [{ display: c.payor }],
          class: [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "plan" }] }, value: c.plan, name: c.plan }],
          period: { start: day(c.start), ...(c.end === undefined ? {} : { end: day(c.end) }) },
        },
        c.key,
        `urn:uuid:${crypto.randomUUID()}`,
      ),
    );
    return [patient, ...visits, ...coverages];
  });

  return { resourceType: "Bundle", type: "transaction", entry: entries } as Bundle;
}

if (import.meta.main) {
  const fhir = new FhirClient();
  console.log(`Seeding ${SEEDS.length} synthetic patients into ${fhir.base}`);
  const result = await fhir.transaction(buildSeedBundle());
  const statuses = (result.entry ?? []).map((e) => e.response?.status ?? "?");
  const tally = statuses.reduce<Record<string, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
  console.log("Server responses:", tally);
  for (const s of SEEDS) console.log(`  ${s.given} ${s.family}: expected ${s.outcome}`);
}
