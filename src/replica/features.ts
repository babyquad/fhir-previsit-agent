/**
 * Perception over FHIR: turn one appointment into the contract's features.
 *
 * Used twice: during observation (to label each trace with the facts of the
 * case) and at run time (so the replica sees new cases the same way). Only
 * derived values come out: no names, ids, dates of birth or member ids.
 */

import type { FhirClient, Resource } from "../fhir";
import type { FeatureValue } from "./contract";

type Coverage = { status?: string; period?: { start?: string; end?: string }; type?: { coding?: { code?: string }[] } };
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export type Perceived = {
  features: Record<string, FeatureValue>;
  /** For the staff-facing output only; never written into a trace. */
  display: { patientRef: string; patientName: string; visitDay: string };
};

export async function perceive(fhir: FhirClient, appointmentId: string): Promise<Perceived> {
  const [appt] = await fhir.search("Appointment", { _id: appointmentId });
  if (!appt) throw new Error(`appointment ${appointmentId} not found`);
  const visitDay = String(appt.start).slice(0, 10);
  const patientRef = ((appt.participant as { actor?: { reference?: string } }[] | undefined) ?? [])
    .map((p) => p.actor?.reference ?? "")
    .find((ref) => ref.startsWith("Patient/"));
  if (!patientRef) throw new Error(`appointment ${appointmentId} has no patient`);

  const [patients, coverages, referrals] = await Promise.all([
    fhir.search("Patient", { _id: patientRef.split("/")[1]! }),
    fhir.search("Coverage", { beneficiary: patientRef }) as Promise<(Resource & Coverage)[]>,
    fhir.search("ServiceRequest", { subject: patientRef, status: "active" }),
  ]);
  const patient = patients[0];

  const active = coverages.filter((c) => c.status === "active");
  const covering = active.filter((c) => (!c.period?.start || c.period.start <= visitDay) && (!c.period?.end || c.period.end >= visitDay));
  // Best policy: one that covers the visit, else the active one that ends last.
  const best =
    covering[0] ??
    [...active].sort((a, b) => String(b.period?.end ?? "9999").localeCompare(String(a.period?.end ?? "9999")))[0];

  const birth = typeof patient?.birthDate === "string" ? patient.birthDate : null;
  const visitType = (appt.serviceType as { coding?: { code?: string }[] }[] | undefined)?.[0]?.coding?.[0]?.code ?? null;
  const region = (patient?.address as { district?: string }[] | undefined)?.[0]?.district ?? null;
  const name = (patient?.name as { given?: string[]; family?: string }[] | undefined)?.[0];

  return {
    features: {
      coverage_on_file: coverages.length > 0,
      active_coverage: active.length > 0,
      days_covered_after_visit: best?.period?.end ? daysBetween(visitDay, best.period.end) : null,
      active_policies_on_visit: covering.length,
      plan_type: best?.type?.coding?.[0]?.code ?? null,
      visit_type: visitType,
      referral_on_file: referrals.length > 0,
      patient_age: birth ? Math.floor(daysBetween(birth, visitDay) / 365.25) : null,
      visit_weekday: WEEKDAYS[new Date(`${visitDay}T12:00:00Z`).getUTCDay()]!,
      home_region: region,
    },
    display: { patientRef, patientName: [name?.given?.join(" "), name?.family].filter(Boolean).join(" ") || "(no name)", visitDay },
  };
}
