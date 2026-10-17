/**
 * In-memory stand-in for a FHIR server, implementing just the search
 * parameters this project uses. Tests pass its `fetch` to FhirClient, so
 * they run offline and deterministically.
 */

import { DEMO_TAG_PARAM, type Resource } from "../src/fhir";

export const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function fixture(): Resource[] {
  const patient = (id: string, given: string, family: string, birthDate: string): Resource => ({
    resourceType: "Patient",
    id,
    name: [{ given: [given], family }],
    birthDate,
    // Fields that must NEVER reach the model:
    address: [{ line: ["1 Main St"], city: "Raleigh" }],
    telecom: [{ system: "phone", value: "919-555-0100" }],
  });
  const appt = (id: string, patientId: string, inDays: number, status = "booked"): Resource => ({
    resourceType: "Appointment",
    id,
    status,
    description: `visit ${id}`,
    start: `${day(inDays)}T14:00:00Z`,
    participant: [{ actor: { reference: `Patient/${patientId}` } }],
  });
  const cov = (id: string, patientId: string, status: string, start: number, end?: number): Resource => ({
    resourceType: "Coverage",
    id,
    status,
    beneficiary: { reference: `Patient/${patientId}` },
    subscriberId: `MEMBER-${id}-99887766`,
    payor: [{ display: "Demo Plan" }],
    period: { start: day(start), ...(end === undefined ? {} : { end: day(end) }) },
  });

  return [
    patient("p1", "Maria", "Alvarez", "1958-03-14"),
    patient("p2", "James", "Okafor", "1971-11-02"),
    patient("p3", "Linda", "Chen", "1989-07-21"),
    patient("p4", "Robert", "Haynes", "1949-01-30"),
    patient("p6", "Maria", "Alvarado", "1993-09-17"),
    patient("p7", "Samuel", "Rivera", "1965-12-01"),
    appt("a1", "p1", 2),
    appt("a2", "p2", 6),
    appt("a3", "p3", 4),
    appt("a4", "p4", 9),
    appt("a6", "p6", 3, "cancelled"),
    appt("a7", "p7", 20),
    cov("c1", "p1", "active", -200, 165),
    cov("c2", "p2", "active", -360, 3),
    cov("c4", "p4", "cancelled", -500),
    cov("c6", "p6", "active", -90, 275),
    cov("c7", "p7", "active", -100, 265),
  ];
}

export type Recorded = { url: URL; method: string };

export function fakeFhir(resources = fixture()) {
  const requests: Recorded[] = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    requests.push({ url, method: init?.method ?? "GET" });
    const type = url.pathname.split("/").pop()!;
    const p = url.searchParams;

    if (p.get("_tag") !== DEMO_TAG_PARAM) {
      return Response.json({ resourceType: "OperationOutcome", issue: [{ diagnostics: "test server requires the demo tag" }] }, { status: 400 });
    }

    let rows = resources.filter((r) => r.resourceType === type);
    const ref = (r: Resource, key: string) => JSON.stringify(r[key] ?? "");
    if (p.has("_id")) rows = rows.filter((r) => r.id === p.get("_id"));
    if (p.has("name")) {
      const q = p.get("name")!.toLowerCase();
      rows = rows.filter((r) =>
        ((r.name as { given: string[]; family: string }[])[0]!.given.concat((r.name as { family: string }[])[0]!.family))
          .some((part) => part.toLowerCase().startsWith(q)),
      );
    }
    if (p.has("patient")) rows = rows.filter((r) => ref(r, "participant").includes(`"${p.get("patient")}"`));
    if (p.has("beneficiary")) rows = rows.filter((r) => ref(r, "beneficiary").includes(`"${p.get("beneficiary")}"`));
    if (p.has("date")) {
      const from = p.get("date")!.replace(/^ge/, "");
      rows = rows.filter((r) => String(r.start).slice(0, 10) >= from);
    }

    return Response.json({ resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource })) });
  };

  return { fetch: fetchImpl, requests };
}
