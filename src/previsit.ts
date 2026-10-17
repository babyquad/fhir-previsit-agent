/**
 * Pre-visit coverage check: the workflow the agent's tools are built on.
 *
 * Front-desk staff spend a large share of their day confirming that a patient
 * with a visit coming up has insurance on file that is active on the visit
 * date. This module does the lookup and produces a worklist of visits that
 * need a human to act before the patient arrives.
 *
 * Scope, stated plainly: this checks the coverage ON FILE in the EHR. It does
 * not ask the payer (that is an X12 270/271 or a FHIR
 * CoverageEligibilityRequest), and it never contacts the patient. Every
 * output is a recommendation for staff.
 *
 * Minimum necessary: tools return the handful of fields the task needs
 * (no address, phone, SSN, or full member ID), so the model never sees more
 * PHI than the job requires.
 */

import type { FhirClient, Resource } from "./fhir";

export type PatientSummary = { id: string; name: string; birthYear: string | null };
export type AppointmentSummary = { id: string; patientId: string; start: string; status: string; reason: string | null };
export type CoverageSummary = {
  id: string;
  status: string;
  payor: string | null;
  plan: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  memberIdLast4: string | null;
};

export type Flag = "OK" | "EXPIRES_BEFORE_VISIT" | "NOT_ACTIVE" | "NO_COVERAGE_ON_FILE";

export type WorklistItem = {
  patient: PatientSummary;
  appointment: AppointmentSummary;
  flag: Flag;
  coverage: CoverageSummary | null;
  recommendedAction: string;
};

const ACTIONS: Record<Flag, string> = {
  OK: "No action: active coverage on file for the visit date.",
  EXPIRES_BEFORE_VISIT:
    "Coverage on file ends before the visit. Ask the patient for their current insurance card before the visit.",
  NOT_ACTIVE: "Coverage on file is not active. Confirm current insurance with the patient or discuss self-pay.",
  NO_COVERAGE_ON_FILE: "No insurance on file. Collect insurance details or start the self-pay conversation.",
};

/** Upcoming means these statuses: the visit is still expected to happen. */
const UPCOMING = new Set(["proposed", "pending", "booked"]);

// ---------- field minimization ----------

export function summarizePatient(r: Resource): PatientSummary {
  const names = (r.name as { given?: string[]; family?: string; text?: string }[] | undefined) ?? [];
  const n = names[0];
  const name = n?.text ?? [n?.given?.join(" "), n?.family].filter(Boolean).join(" ");
  const birthDate = typeof r.birthDate === "string" ? r.birthDate : null;
  return { id: r.id ?? "", name: name || "(no name)", birthYear: birthDate?.slice(0, 4) ?? null };
}

export function summarizeAppointment(r: Resource): AppointmentSummary {
  const participants = (r.participant as { actor?: { reference?: string } }[] | undefined) ?? [];
  const patientRef = participants.map((p) => p.actor?.reference ?? "").find((ref) => ref.startsWith("Patient/"));
  const serviceType = (r.serviceType as { text?: string; coding?: { display?: string }[] }[] | undefined)?.[0];
  return {
    id: r.id ?? "",
    patientId: patientRef?.split("/")[1] ?? "",
    start: String(r.start ?? ""),
    status: String(r.status ?? "unknown"),
    reason: (r.description as string | undefined) ?? serviceType?.text ?? serviceType?.coding?.[0]?.display ?? null,
  };
}

export function summarizeCoverage(r: Resource): CoverageSummary {
  const period = (r.period as { start?: string; end?: string } | undefined) ?? {};
  const payor = (r.payor as { display?: string }[] | undefined)?.[0]?.display ?? null;
  const plan = (r.class as { name?: string; value?: string }[] | undefined)?.find((c) => c.name)?.name ?? null;
  const memberId = typeof r.subscriberId === "string" ? r.subscriberId : null;
  return {
    id: r.id ?? "",
    status: String(r.status ?? "unknown"),
    payor,
    plan,
    periodStart: period.start ?? null,
    periodEnd: period.end ?? null,
    memberIdLast4: memberId ? memberId.slice(-4) : null,
  };
}

// ---------- the decision ----------

/** Pure function: which flag does this visit get, given the coverages on file? */
export function classify(visitDate: string, coverages: CoverageSummary[]): { flag: Flag; coverage: CoverageSummary | null } {
  const day = visitDate.slice(0, 10);
  if (coverages.length === 0) return { flag: "NO_COVERAGE_ON_FILE", coverage: null };

  const active = coverages.filter((c) => c.status === "active");
  const covering = active.find((c) => (!c.periodStart || c.periodStart <= day) && (!c.periodEnd || c.periodEnd >= day));
  if (covering) return { flag: "OK", coverage: covering };

  // Active but the period ends first: the most common real case (plan year rollover, job change).
  const lapsing = active.find((c) => c.periodEnd && c.periodEnd < day);
  if (lapsing) return { flag: "EXPIRES_BEFORE_VISIT", coverage: lapsing };

  return { flag: "NOT_ACTIVE", coverage: coverages[0] ?? null };
}

// ---------- FHIR-backed operations (these are what the tools call) ----------

/**
 * FHIR `name` search matches ONE name part by prefix, so "Maria Alva" finds
 * nothing. Query on the longest token, then keep patients where every token
 * prefixes some part of their name (front-desk style: "maria alva" matches
 * Maria Alvarez and Maria Alvarado, which is the ambiguity we want surfaced).
 */
export async function findPatients(fhir: FhirClient, name: string): Promise<PatientSummary[]> {
  const tokens = name.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const anchor = [...tokens].sort((a, b) => b.length - a.length)[0];
  if (!anchor) return [];
  const found = (await fhir.search("Patient", { name: anchor })).map(summarizePatient);
  return found.filter((p) => {
    const parts = p.name.toLowerCase().split(/\s+/);
    return tokens.every((t) => parts.some((part) => part.startsWith(t)));
  });
}

export async function listAppointments(fhir: FhirClient, patientId: string, days = 30): Promise<AppointmentSummary[]> {
  const { from, to } = window(days);
  // Lower bound on the server; the upper bound is applied here because a plain
  // Record can't carry FHIR's repeated `date` parameter.
  const found = await fhir.search("Appointment", { patient: `Patient/${patientId}`, date: `ge${from}` });
  return found
    .map(summarizeAppointment)
    .filter((a) => a.start.slice(0, 10) <= to && UPCOMING.has(a.status))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export async function getCoverage(fhir: FhirClient, patientId: string): Promise<CoverageSummary[]> {
  const found = await fhir.search("Coverage", { beneficiary: `Patient/${patientId}` });
  return found.map(summarizeCoverage);
}

/**
 * The full workflow: every upcoming visit in the window, checked against the
 * coverage on file. Problems sort first so staff work the list top down.
 */
export async function buildWorklist(fhir: FhirClient, days = 14): Promise<WorklistItem[]> {
  const { from, to } = window(days);
  const appts = (await fhir.search("Appointment", { date: `ge${from}` }))
    .map(summarizeAppointment)
    .filter((a) => UPCOMING.has(a.status) && a.patientId && a.start.slice(0, 10) <= to);

  const patientIds = [...new Set(appts.map((a) => a.patientId))];
  const [patients, coverages] = await Promise.all([
    Promise.all(patientIds.map(async (id) => (await fhir.search("Patient", { _id: id })).map(summarizePatient)[0])),
    Promise.all(patientIds.map((id) => getCoverage(fhir, id))),
  ]);
  const byPatient = new Map(patientIds.map((id, i) => [id, { patient: patients[i], coverages: coverages[i] ?? [] }]));

  const items = appts.map((appointment): WorklistItem => {
    const entry = byPatient.get(appointment.patientId);
    const patient = entry?.patient ?? { id: appointment.patientId, name: "(unknown patient)", birthYear: null };
    const { flag, coverage } = classify(appointment.start, entry?.coverages ?? []);
    return { patient, appointment, flag, coverage, recommendedAction: ACTIONS[flag] };
  });

  return items.sort((a, b) => Number(a.flag === "OK") - Number(b.flag === "OK") || a.appointment.start.localeCompare(b.appointment.start));
}

function window(days: number) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 86_400_000);
  return { from: now.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
