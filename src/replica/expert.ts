/**
 * SIMULATED top performer. Stands in for the human being observed.
 *
 * She works each pre-visit case the way an experienced front-desk lead
 * would, including habits that are written down nowhere: she flags HMO
 * patients going to a specialist without a referral, she asks for the
 * primary policy when two are active, and she reminds patients at check-in
 * when coverage ends within about two weeks of the visit. She also makes
 * the occasional mistake (NOISE), as people do.
 *
 * She reads FHIR through a RecordingSession, so what she looks at is
 * captured as she works. The learner never imports this file: it only sees
 * her traces.
 */

import type { Resource } from "../fhir";
import { ACTIONS, type Action } from "./contract";
import type { RecordingSession } from "./recorder";
import { SPECIALIST_LIKE, rng } from "./population";

export const NOISE = 0.04;

type Coverage = { status?: string; period?: { start?: string; end?: string }; type?: { coding?: { code?: string }[] } };

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function makeExpert(seed = 11, noise = NOISE) {
  const r = rng(seed);
  // People time, in ms: opening a chart, reading a policy, checking referrals.
  const spend = (lo: number, hi: number, s: RecordingSession) => (s.humanMs += r.int(lo * 1000, hi * 1000));

  return async function work(s: RecordingSession, appointmentId: string): Promise<Action> {
    const [appt] = await s.search("Appointment", { _id: appointmentId });
    spend(15, 40, s);
    const visitDay = String(appt!.start).slice(0, 10);
    const patientRef = (appt!.participant as { actor: { reference: string } }[])[0]!.actor.reference;

    // Identity check, every time: name and date of birth. Never the address.
    const [patient] = await s.search("Patient", { _id: patientRef.split("/")[1]! });
    void (patient!.name as unknown[])[0];
    void patient!.birthDate;
    spend(10, 25, s);

    const coverages = (await s.search("Coverage", { beneficiary: patientRef })) as (Resource & Coverage)[];
    spend(20, 60, s);

    let action: Action;
    let note: string;
    if (coverages.length === 0) {
      action = "COLLECT_INSURANCE";
      note = "nothing on file";
    } else {
      const active = coverages.filter((c) => c.status === "active");
      const covering = active.filter((c) => (!c.period?.start || c.period.start <= visitDay) && (!c.period?.end || c.period.end >= visitDay));
      if (active.length === 0) {
        action = "CONFIRM_OR_SELF_PAY";
        note = "policy not active";
      } else if (covering.length === 0) {
        action = "REQUEST_NEW_CARD";
        note = "ends before the visit";
      } else if (covering.length >= 2) {
        action = "CONFIRM_PRIMARY";
        note = "two active policies";
        spend(30, 90, s);
      } else {
        const policy = covering[0]!;
        const planType = policy.type?.coding?.[0]?.code;
        const visitType = (appt!.serviceType as { coding: { code: string }[] }[])[0]!.coding[0]!.code;
        let needsReferral = false;
        if (planType === "HMO" && SPECIALIST_LIKE.has(visitType)) {
          // Only for HMO specialist-type visits does she open the referrals tab.
          const refs = await s.search("ServiceRequest", { subject: patientRef, status: "active" });
          spend(30, 120, s);
          needsReferral = refs.length === 0;
        }
        const left = policy.period?.end ? daysBetween(visitDay, policy.period.end) : null;
        if (needsReferral) {
          action = "GET_REFERRAL";
          note = "HMO, specialist visit, no referral";
        } else if (left !== null && left <= 14) {
          action = "REMIND_AT_CHECKIN";
          note = "coverage ends soon after the visit";
        } else {
          action = "NO_ACTION";
          note = "ok";
        }
      }
    }

    if (r.next() < noise) {
      action = r.pick(ACTIONS.filter((a) => a !== action));
      note = "(slip)";
    }
    spend(10, 30, s);
    await s.writeDecision(
      { resourceType: "Task", status: "requested", intent: "proposal", focus: { reference: `Appointment/${appointmentId}` } },
      action,
      note,
    );
    return action;
  };
}
