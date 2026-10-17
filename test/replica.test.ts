process.env.AUDIT_LOG = "off";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FhirClient } from "../src/fhir";
import { ESCALATE, FEATURES, Trace, type Procedure } from "../src/replica/contract";
import { gate, learningCurve, score, weekOf } from "../src/replica/evaluate";
import { explain } from "../src/replica/explain";
import { learn } from "../src/replica/learn";
import { memFhir } from "../src/replica/memfhir";
import { novelCases } from "../src/replica/novel";
import { OBSERVATION_START, simulateObservation } from "../src/replica/pipeline";
import { REPLICA_TAG_PARAM, addDays, toResources } from "../src/replica/population";
import { decide, runReplica } from "../src/replica/replica";

let traces: Trace[];
let train: Trace[];
let heldOut: Trace[];
let proc: Procedure;

beforeAll(async () => {
  traces = await simulateObservation({ weeks: 4, perDay: 15 });
  train = traces.filter((t) => weekOf(t, OBSERVATION_START) < 3);
  heldOut = traces.filter((t) => weekOf(t, OBSERVATION_START) >= 3);
  proc = learn(train);
});

function novelServer() {
  const novel = novelCases("t", addDays(OBSERVATION_START, 35));
  const { resources, cases } = toResources(novel.map((n) => n.spec));
  const server = memFhir(resources, REPLICA_TAG_PARAM);
  const fhir = new FhirClient({ base: "http://mem/fhir", fetch: server.fetch, tag: REPLICA_TAG_PARAM });
  return { novel, cases, server, fhir };
}

describe("observation", () => {
  test("records which fields were opened, never their values", () => {
    const t = traces[0]!;
    expect(() => Trace.parse(t)).not.toThrow();
    const targets = t.events.map((e) => e.target);
    expect(targets).toContain("Coverage.status");
    expect(targets.some((x) => x.startsWith("Patient.birthDate"))).toBe(true);
    // No dates, plan codes or names in event targets.
    expect(targets.join(" ")).not.toMatch(/\d{4}-\d{2}-\d{2}|HMO|PPO/);
    expect(targets.some((x) => x.startsWith("Patient.address"))).toBe(false);
  });

  test("traces carry derived features only, no identifiers", () => {
    for (const t of traces.slice(0, 20)) {
      expect(Object.keys(t.features).sort()).toEqual(FEATURES.map((f) => f.name).sort());
      const json = JSON.stringify({ ...t, observed_on: "" });
      // No member ids, no dates (so no date of birth), no patient names.
      expect(json).not.toMatch(/DEMO-\d{4}|\d{4}-\d{2}-\d{2}|"given"|"family"/);
    }
  });

  test("she only opens referrals for HMO specialist-type visits", () => {
    const opened = traces.filter((t) => t.events.some((e) => e.target.startsWith("ServiceRequest?")));
    expect(opened.length).toBeGreaterThan(0);
    for (const t of opened) {
      expect(t.features.plan_type).toBe("HMO");
      expect(["specialist", "pre_op", "imaging"]).toContain(t.features.visit_type as string);
    }
  });
});

describe("learning", () => {
  test("recovers the unwritten referral habit, including her visit-type grouping", () => {
    const r = proc.rules.find((x) => x.action === "GET_REFERRAL" && x.support >= 10)!;
    expect(r).toBeDefined();
    const conds = JSON.stringify(r.when);
    expect(conds).toContain('"plan_type","op":"eq","value":"HMO"');
    expect(r.when.find((c) => c.feature === "visit_type")?.value).toEqual(["imaging", "pre_op", "specialist"]);
  });

  test("learns the reminder threshold at about two weeks", () => {
    const r = proc.rules.find((x) => x.action === "REMIND_AT_CHECKIN")!;
    const cut = r.when.find((c) => c.feature === "days_covered_after_visit" && c.op === "le" && !c.negate)!;
    expect(cut.value as number).toBeGreaterThanOrEqual(14);
    expect(cut.value as number).toBeLessThan(16);
  });

  test("ignores data she never looked at", () => {
    expect(proc.ignored).toContain("home_region");
    expect(JSON.stringify(proc.rules)).not.toContain("home_region");
  });

  test("more weeks of watching does not make it worse, and three weeks gets above 90%", () => {
    const curve = learningCurve(train, heldOut);
    expect(curve.at(-1)!.agreementOnDecided).toBeGreaterThanOrEqual(curve[0]!.agreementOnDecided);
    expect(curve.at(-1)!.agreementOnDecided).toBeGreaterThan(0.9);
  });

  test("the promotion gate holds at 95%", () => {
    const s = score(proc, heldOut);
    expect(gate(s).ready).toBe(s.agreementOnDecided >= 0.95 && s.escalationRate <= 0.15);
  });
});

describe("replica on novel cases", () => {
  test("never gives a wrong answer: right, or handed to a person", async () => {
    const { novel, cases, fhir } = novelServer();
    const items = await runReplica(fhir, proc, cases.map((c) => c.appointmentId));
    const wrong = items.filter((it, i) => it.decision.action !== novel[i]!.expected && it.decision.action !== ESCALATE);
    expect(wrong).toEqual([]);
  });

  test("escalates a plan type it never saw", () => {
    const d = decide(proc, { ...heldOut.find((t) => t.features.plan_type === "PPO")!.features, plan_type: "MEDICAID" });
    expect(d.action).toBe(ESCALATE);
    expect(d.reason).toContain("never seen");
  });

  test("escalates when two rules fit a combination never observed", async () => {
    const { cases, fhir } = novelServer();
    const [item] = await runReplica(fhir, proc, [cases[1]!.appointmentId]); // HMO imaging, no referral, ends in 5 days
    expect(item!.decision.action).toBe(ESCALATE);
    expect(item!.decision.reason).toContain("never observed");
  });

  test("is read-only unless writing is turned on; then it posts proposal Tasks", async () => {
    const { cases, fhir, server } = novelServer();
    const before = server.store.length;
    await runReplica(fhir, proc, cases.map((c) => c.appointmentId));
    expect(server.store.length).toBe(before);

    const items = await runReplica(fhir, proc, cases.map((c) => c.appointmentId), { write: true });
    const tasks = server.store.filter((r) => r.resourceType === "Task");
    expect(tasks.length).toBe(items.filter((i) => i.decision.action !== "NO_ACTION").length);
    expect(tasks.every((t) => t.intent === "proposal" && t.status === "requested")).toBe(true);
    expect(tasks.some((t) => (t.code as { text: string }).text === "Needs human review")).toBe(true);
  });
});

describe("explain", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  let reply = "";
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 2000, output_tokens: 500 },
          content: [{ type: "text", text: reply }],
        }),
    });
  });
  afterAll(() => {
    server.stop(true);
    process.env.ANTHROPIC_API_KEY = saved.key;
    process.env.ANTHROPIC_BASE_URL = saved.base;
  });

  test("asks about the unseen combination even with no model", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    const r = await explain(proc, train);
    expect(r.writer).toBe("template");
    expect(r.questions[0]!.question).toContain("never came up together");
  });

  test("uses the model's SOP when it cites real rules, rejects it when it does not", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;
    const sop = (ids: string[]) => JSON.stringify({ title: "SOP", steps: [{ rule_ids: ids, instruction: "Check coverage." }], questions_for_worker: [], caveats: [] });

    reply = sop(["R1"]);
    const ok = await explain(proc, train);
    expect(ok.writer).toBe("llm");
    expect(ok.estCostUsd).toBe(0.018);

    reply = sop(["R99"]);
    const bad = await explain(proc, train);
    expect(bad.writer).toBe("template");
    expect(bad.fallbackReason).toContain("R99");
  });
});
