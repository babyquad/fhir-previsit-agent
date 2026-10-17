/**
 * The agent: answer a front-desk question by calling the read-only FHIR tools.
 *
 * Two planners, one result shape:
 *   llm        Claude decides which tools to call (manual tool-use loop).
 *   heuristic  deterministic intent rules. Used when no Claude credentials are
 *              configured, and as the fallback on ANY model error, so the
 *              front desk still gets its worklist when the model is down.
 *
 * Every step is recorded (tool, input, latency, ok/error) so a run can be
 * reviewed after the fact.
 */

import Anthropic from "@anthropic-ai/sdk";
import { FhirClient, FhirError } from "./fhir";
import { classify, type WorklistItem } from "./previsit";
import { CLAUDE_TOOLS, toolByName } from "./tools";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const MAX_STEPS = 8;
// Opus 5.5 list price per million tokens, for the per-run cost estimate.
const PRICE = { input: 4, output: 20 };

export type Step = { tool: string; input: unknown; ms: number; ok: boolean; error?: string };
export type AgentResult = {
  planner: "llm" | "heuristic";
  answer: string;
  steps: Step[];
  usage?: { inputTokens: number; outputTokens: number; estCostUsd: number };
  fallbackReason?: string;
};

const SYSTEM = `You help a clinic's front desk prepare for upcoming visits by checking insurance coverage on file in the EHR.

Rules:
- You can only read. You cannot change records or contact patients. Recommend actions for staff; never say an action was taken.
- Coverage data is what is on file in the EHR, not a live check with the payer. Say so when it matters.
- Use the fewest tool calls that answer the question. For questions about the whole schedule, use build_previsit_worklist.
- If a name matches more than one patient, list the matches (name and birth year) and ask which one. Do not guess.
- Never invent a patient, visit, payer or date. If a tool returns nothing, say nothing was found.
- Keep answers short and scannable: one line per visit that needs action, with the recommended action.`;

export async function runAgent(question: string, fhir = new FhirClient()): Promise<AgentResult> {
  if (process.env.AGENT_PLANNER === "heuristic") return runHeuristic(question, fhir, "AGENT_PLANNER=heuristic");

  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (err) {
    return runHeuristic(question, fhir, `no Claude credentials (${(err as Error).message})`);
  }

  try {
    return await runLlm(client, question, fhir);
  } catch (err) {
    // Fail soft: a model outage downgrades the planner, it does not take the worklist away.
    const reason = err instanceof Anthropic.APIError ? `Claude API ${err.status ?? "error"}` : (err as Error).message;
    return runHeuristic(question, fhir, reason);
  }
}

async function runLlm(client: Anthropic, question: string, fhir: FhirClient): Promise<AgentResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: question }];
  const steps: Step[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 0; turn < MAX_STEPS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: CLAUDE_TOOLS,
      messages,
      output_config: { effort: "medium" },
      // On a safety decline, the API re-runs the request on a fallback model it picks.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      return done("The model declined this request. No tools were run for it.");
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return done(text || "(no answer)");
    }

    messages.push({ role: "assistant", content: response.content });
    // Parallel tool calls run concurrently and go back in ONE user message.
    const results = await Promise.all(toolUses.map((use) => execute(fhir, use.name, use.input, steps)));
    messages.push({
      role: "user",
      content: toolUses.map((use, i) => ({
        type: "tool_result" as const,
        tool_use_id: use.id,
        content: results[i]!.content,
        is_error: results[i]!.isError,
      })),
    });
  }

  return done(`Stopped after ${MAX_STEPS} steps without a final answer.`);

  function done(answer: string): AgentResult {
    const estCostUsd = (inputTokens * PRICE.input + outputTokens * PRICE.output) / 1_000_000;
    return { planner: "llm", answer, steps, usage: { inputTokens, outputTokens, estCostUsd: round(estCostUsd) } };
  }
}

async function execute(fhir: FhirClient, name: string, input: unknown, steps: Step[]) {
  const started = performance.now();
  const tool = toolByName.get(name);
  try {
    if (!tool) throw new Error(`unknown tool ${name}`);
    const out = await tool.run(fhir, input);
    steps.push({ tool: name, input, ms: Math.round(performance.now() - started), ok: true });
    return { content: JSON.stringify(out), isError: false };
  } catch (err) {
    const error = err instanceof FhirError ? `${err.message}${err.diagnostics ? `: ${err.diagnostics}` : ""}` : (err as Error).message;
    steps.push({ tool: name, input, ms: Math.round(performance.now() - started), ok: false, error });
    return { content: error, isError: true };
  }
}

// ---------- deterministic planner ----------

async function runHeuristic(question: string, fhir: FhirClient, fallbackReason: string): Promise<AgentResult> {
  const steps: Step[] = [];
  const days = parseDays(question);
  const name = parseName(question);

  const call = async <T>(tool: string, input: unknown): Promise<T> => {
    const r = await execute(fhir, tool, input, steps);
    if (r.isError) throw new Error(r.content);
    return JSON.parse(r.content) as T;
  };

  try {
    if (!name) {
      const worklist = await call<WorklistItem[]>("build_previsit_worklist", { days });
      return { planner: "heuristic", answer: formatWorklist(worklist, days), steps, fallbackReason };
    }

    const matches = await call<{ id: string; name: string; birthYear: string | null }[]>("find_patient", { name });
    if (matches.length === 0) return { planner: "heuristic", answer: `No patient found matching "${name}".`, steps, fallbackReason };
    if (matches.length > 1) {
      const list = matches.map((m) => `- ${m.name} (born ${m.birthYear ?? "unknown"})`).join("\n");
      return { planner: "heuristic", answer: `More than one patient matches "${name}". Which one?\n${list}`, steps, fallbackReason };
    }

    const patient = matches[0]!;
    const [appts, coverages] = await Promise.all([
      call<{ start: string; reason: string | null }[]>("list_appointments", { patient_id: patient.id, days }),
      call<Parameters<typeof classify>[1]>("get_coverage", { patient_id: patient.id }),
    ]);
    if (appts.length === 0) {
      return { planner: "heuristic", answer: `${patient.name} has no upcoming visits in the next ${days} days.`, steps, fallbackReason };
    }
    const lines = appts.map((a) => {
      const { flag } = classify(a.start, coverages);
      return `- ${a.start.slice(0, 10)} ${a.reason ?? "visit"}: ${flag}`;
    });
    const answer = `${patient.name}, next ${days} days:\n${lines.join("\n")}\n(Coverage is what is on file in the EHR, not a live payer check.)`;
    return { planner: "heuristic", answer, steps, fallbackReason };
  } catch (err) {
    return { planner: "heuristic", answer: `Could not complete the lookup: ${(err as Error).message}`, steps, fallbackReason };
  }
}

export function formatWorklist(items: WorklistItem[], days: number): string {
  if (items.length === 0) return `No upcoming visits in the next ${days} days.`;
  const needs = items.filter((i) => i.flag !== "OK");
  const head = `${items.length} upcoming visits in the next ${days} days; ${needs.length} need action before the patient arrives.`;
  const lines = needs.map(
    (i) => `- ${i.appointment.start.slice(0, 10)} ${i.patient.name}: ${i.flag}. ${i.recommendedAction}`,
  );
  return [head, ...lines, "(Coverage is what is on file in the EHR, not a live payer check.)"].join("\n");
}

export function parseDays(q: string): number {
  const m = q.match(/(\d{1,2})\s*days?/i);
  if (m) return Math.min(90, Math.max(1, Number(m[1])));
  if (/\btomorrow\b/i.test(q)) return 1;
  if (/\b(this|next)\s+week\b/i.test(q)) return 7;
  if (/\bmonth\b/i.test(q)) return 30;
  return 14;
}

/** "patient Maria Lopez", "for Maria Lopez", "is Maria Lopez covered": two or more capitalized words. */
export function parseName(q: string): string | null {
  // Keywords in any case; the name itself must be capitalized words.
  const m = q.match(/\b(?:[Pp]atient|[Ff]or|[Ii]s|[Cc]heck|[Aa]bout)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)+)/);
  return m?.[1] ?? null;
}

function round(n: number) {
  return Math.round(n * 1_000_000) / 1_000_000;
}
