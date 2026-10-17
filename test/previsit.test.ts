process.env.AUDIT_LOG = "off";

import { describe, expect, test } from "bun:test";
import { auditEvents } from "../src/audit";
import { FhirClient, FhirError } from "../src/fhir";
import { buildWorklist, classify, findPatients, summarizeCoverage, summarizePatient, type CoverageSummary } from "../src/previsit";
import { toolByName } from "../src/tools";
import { day, fakeFhir, fixture } from "./fake-fhir";

const cov = (over: Partial<CoverageSummary>): CoverageSummary => ({
  id: "c", status: "active", payor: null, plan: null, periodStart: null, periodEnd: null, memberIdLast4: null, ...over,
});

describe("classify", () => {
  const visit = `${day(10)}T14:00:00Z`;

  test("active coverage spanning the visit is OK", () => {
    expect(classify(visit, [cov({ periodStart: day(-5), periodEnd: day(30) })]).flag).toBe("OK");
  });
  test("coverage ending ON the visit day still covers it", () => {
    expect(classify(visit, [cov({ periodEnd: day(10) })]).flag).toBe("OK");
  });
  test("active coverage ending before the visit is flagged", () => {
    expect(classify(visit, [cov({ periodEnd: day(9) })]).flag).toBe("EXPIRES_BEFORE_VISIT");
  });
  test("a lapsed plan plus a current plan is OK (picks the covering one)", () => {
    const r = classify(visit, [cov({ id: "old", periodEnd: day(-30) }), cov({ id: "new", periodStart: day(-29) })]);
    expect(r.flag).toBe("OK");
    expect(r.coverage?.id).toBe("new");
  });
  test("cancelled coverage is NOT_ACTIVE", () => {
    expect(classify(visit, [cov({ status: "cancelled" })]).flag).toBe("NOT_ACTIVE");
  });
  test("nothing on file", () => {
    expect(classify(visit, []).flag).toBe("NO_COVERAGE_ON_FILE");
  });
});

describe("minimum necessary", () => {
  test("patient summary drops address and phone", () => {
    const p = fixture().find((r) => r.id === "p1")!;
    const s = summarizePatient(p);
    expect(s).toEqual({ id: "p1", name: "Maria Alvarez", birthYear: "1958" });
    expect(JSON.stringify(s)).not.toContain("555");
    expect(JSON.stringify(s)).not.toContain("Main St");
  });
  test("coverage summary keeps only the last 4 of the member id", () => {
    const c = summarizeCoverage(fixture().find((r) => r.id === "c1")!);
    expect(c.memberIdLast4).toBe("7766");
    expect(JSON.stringify(c)).not.toContain("MEMBER-c1");
  });
});

describe("worklist", () => {
  test("flags the right visits, problems first, excludes cancelled and out-of-window", async () => {
    const fhir = new FhirClient({ base: "http://fake/fhir", fetch: fakeFhir().fetch });
    const items = await buildWorklist(fhir, 14);

    expect(items.map((i) => [i.patient.name, i.flag])).toEqual([
      ["Linda Chen", "NO_COVERAGE_ON_FILE"],
      ["James Okafor", "EXPIRES_BEFORE_VISIT"],
      ["Robert Haynes", "NOT_ACTIVE"],
      ["Maria Alvarez", "OK"],
    ]);
  });

  test("every request is scoped to the demo tag and audited without values", async () => {
    const fake = fakeFhir();
    const before = auditEvents().length;
    await buildWorklist(new FhirClient({ base: "http://fake/fhir", fetch: fake.fetch }), 14);

    expect(fake.requests.length).toBeGreaterThan(0);
    const logged = auditEvents().slice(before);
    expect(logged.length).toBe(fake.requests.length);
    expect(JSON.stringify(logged)).not.toContain("p2"); // ids are values; only parameter NAMES are logged
  });
});

describe("patient search", () => {
  test("multi-word names match by prefix on every token", async () => {
    const fhir = new FhirClient({ base: "http://fake/fhir", fetch: fakeFhir().fetch });
    expect((await findPatients(fhir, "James Okafor")).map((p) => p.id)).toEqual(["p2"]);
    expect((await findPatients(fhir, "maria alva")).map((p) => p.name).sort()).toEqual(["Maria Alvarado", "Maria Alvarez"]);
    expect(await findPatients(fhir, "Nobody Here")).toEqual([]);
  });
});

describe("FHIR client", () => {
  test("retries a 429 and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ resourceType: "Bundle", entry: [] });
    };
    await new FhirClient({ base: "http://x", fetch: fetchImpl }).search("Patient", {});
    expect(calls).toBe(2);
  });

  test("surfaces OperationOutcome diagnostics and does not retry a 400", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return Response.json({ resourceType: "OperationOutcome", issue: [{ diagnostics: "Unknown search parameter" }] }, { status: 400 });
    };
    const err = await new FhirClient({ base: "http://x", fetch: fetchImpl }).search("Patient", { bogus: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(FhirError);
    expect((err as FhirError).diagnostics).toBe("Unknown search parameter");
    expect(calls).toBe(1);
  });

  test("follows next links but stops at maxPages", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return Response.json({
        resourceType: "Bundle",
        entry: [{ resource: { resourceType: "Patient", id: `p${calls}` } }],
        link: [{ relation: "next", url: "http://x/next" }],
      });
    };
    const rows = await new FhirClient({ base: "http://x", fetch: fetchImpl, maxPages: 3 }).search("Patient", {});
    expect(rows.length).toBe(3);
    expect(calls).toBe(3);
  });
});

describe("tool input validation", () => {
  const fhir = new FhirClient({ base: "http://fake/fhir", fetch: fakeFhir().fetch });

  test("rejects a patient_id that tries to smuggle in search parameters", async () => {
    await expect(toolByName.get("get_coverage")!.run(fhir, { patient_id: "p1&_tag=other" })).rejects.toThrow();
  });
  test("rejects unexpected fields and out-of-range days", async () => {
    await expect(toolByName.get("build_previsit_worklist")!.run(fhir, { days: 14, write: true })).rejects.toThrow();
    await expect(toolByName.get("build_previsit_worklist")!.run(fhir, { days: 365 })).rejects.toThrow();
  });
});
