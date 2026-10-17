process.env.AUDIT_LOG = "off";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseDays, parseName, runAgent } from "../src/agent";
import { FhirClient } from "../src/fhir";
import { fakeFhir } from "./fake-fhir";

const fhir = () => new FhirClient({ base: "http://fake/fhir", fetch: fakeFhir().fetch });

describe("intent parsing (heuristic planner)", () => {
  test("days", () => {
    expect(parseDays("next 30 days")).toBe(30);
    expect(parseDays("this week")).toBe(7);
    expect(parseDays("tomorrow")).toBe(1);
    expect(parseDays("anything")).toBe(14);
  });
  test("names", () => {
    expect(parseName("Is James Okafor covered?")).toBe("James Okafor");
    expect(parseName("check patient Maria Alva please")).toBe("Maria Alva");
    expect(parseName("Who needs follow-up this week?")).toBeNull();
  });
});

describe("heuristic planner", () => {
  test("asks which patient instead of guessing", async () => {
    process.env.AGENT_PLANNER = "heuristic";
    const r = await runAgent("check Maria Alva", fhir());
    expect(r.answer).toContain("More than one patient");
    expect(r.steps.map((s) => s.tool)).toEqual(["find_patient"]);
  });
});

/**
 * The LLM planner against a fake Messages API: turn 1 asks for the worklist
 * tool, turn 2 answers. Proves the loop wiring (tool_use -> execute ->
 * tool_result in one user message) with no network and no spend.
 */
describe("llm planner", () => {
  const bodies: { messages: { role: string; content: unknown }[]; model: string }[] = [];
  let mode: "ok" | "auth_error" = "ok";
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (mode === "auth_error") {
          return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
        }
        const body = await req.json();
        bodies.push(body);
        const usage = { input_tokens: 1000, output_tokens: 100 };
        const base = { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage };
        if (bodies.length === 1) {
          return Response.json({
            ...base,
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "toolu_1", name: "build_previsit_worklist", input: { days: 14 } }],
          });
        }
        return Response.json({ ...base, stop_reason: "end_turn", content: [{ type: "text", text: "3 visits need action." }] });
      },
    });
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  test("runs the tool the model asked for and returns its answer", async () => {
    delete process.env.AGENT_PLANNER;
    mode = "ok";
    const r = await runAgent("Who needs insurance follow-up?", fhir());

    expect(r.planner).toBe("llm");
    expect(r.answer).toBe("3 visits need action.");
    expect(r.steps).toEqual([expect.objectContaining({ tool: "build_previsit_worklist", ok: true })]);
    // Second request carries the tool result back, in a single user message.
    const last = bodies[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("EXPIRES_BEFORE_VISIT");
    expect(r.usage).toEqual({ inputTokens: 2000, outputTokens: 200, estCostUsd: 0.012 });
  });

  test("falls back to the heuristic planner when the model call fails", async () => {
    delete process.env.AGENT_PLANNER;
    mode = "auth_error";
    const r = await runAgent("Who needs insurance follow-up this week?", fhir());

    expect(r.planner).toBe("heuristic");
    expect(r.fallbackReason).toContain("401");
    expect(r.answer).toContain("need action");
  });
});
