/**
 * Run an observation period: the worker handles each case through a
 * RecordingSession, and each case becomes one contract Trace.
 */

import type { FhirClient } from "../fhir";
import { Trace } from "./contract";
import { perceive } from "./features";
import type { Case } from "./population";
import { RecordingSession } from "./recorder";

export type Worker = (s: RecordingSession, appointmentId: string) => Promise<unknown>;

export async function observe(fhir: FhirClient, cases: Case[], workerId: string, work: Worker): Promise<Trace[]> {
  const traces: Trace[] = [];
  for (const c of cases) {
    const session = new RecordingSession(fhir);
    await work(session, c.appointmentId);
    if (!session.decision) throw new Error(`worker recorded no decision for ${c.caseId}`);
    const { features } = await perceive(fhir, c.appointmentId);
    traces.push(
      Trace.parse({
        schema: "replica.trace/v1",
        case_id: c.caseId,
        worker_id: workerId,
        surface: "fhir",
        observed_on: c.visitDate,
        duration_ms: session.humanMs,
        events: session.events,
        decision: session.decision,
        features,
      }),
    );
  }
  return traces;
}
