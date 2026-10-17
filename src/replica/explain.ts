/**
 * Turn a learned Procedure into something a manager can sign off on:
 * a plain-English SOP, plus questions to put to the worker about the parts
 * of her process the observations could not settle.
 *
 * Claude (claude-opus-5-5) writes it with structured output (zod-validated).
 * Every step must cite rule ids that exist; anything else is rejected and the
 * deterministic writer is used instead. The executable logic never comes
 * from this text: the replica runs the learned rules, the SOP explains them.
 *
 * The deterministic writer always runs too, because its questions come from
 * evidence: low-support rules, threshold edges with no cases near them, and
 * the specific cases where the worker went against her own pattern.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z4 from "zod/v4";
import { ACTION_TEXT, renderCondition, renderRule, type Procedure, type Trace } from "./contract";
import { holds } from "./learn";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const PRICE = { input: 4, output: 20 }; // Opus 5.5, $ per million tokens

const SopSchema = z4.object({
  title: z4.string(),
  steps: z4.array(z4.object({ rule_ids: z4.array(z4.string()), instruction: z4.string() })),
  questions_for_worker: z4.array(z4.object({ about: z4.string(), question: z4.string() })),
  caveats: z4.array(z4.string()),
});
export type Sop = z4.infer<typeof SopSchema>;

export type Question = { about: string; question: string };

/** Evidence-based questions, no model involved. */
export function evidenceQuestions(proc: Procedure, traces: Trace[]): Question[] {
  const qs: Question[] = [];
  // Unseen combinations first: these are where the replica would otherwise have to guess.
  // Only ask about plausible ones: every extra condition was seen on its own under
  // rule A, just never all together (so "no policy on file but coverage active" is skipped).
  const underRule = (id: string) => traces.filter((t) => matches(proc, id, t));
  for (const a of proc.rules) {
    const rows = underRule(a.id);
    for (const c of a.conflicts) {
      const b = proc.rules.find((r) => r.id === c.with);
      if (!b) continue;
      const plausible = c.extras.every((x) => rows.some((t) => holds(x, t.features[x.feature] ?? null)));
      if (!plausible) continue;
      qs.push({
        about: `${a.id} vs ${b.id}`,
        question: `When ${a.when.map(renderCondition).join(" and ") || "any case"} you ${a.action}. When ${c.extras.map(renderCondition).join(" and ")} you ${b.action}. Those never came up together. If they do, which comes first?`,
      });
    }
  }
  for (const r of proc.rules) {
    if (r.support < proc.abstain.min_support || r.agreement < proc.abstain.min_agreement) {
      qs.push({ about: r.id, question: `${renderRule(r)}. Too few or mixed cases to act on alone. Is this how you handle it?` });
    }
  }
  // Threshold edges: is there a gap in the data right at the learned cut-off?
  for (const r of proc.rules) {
    for (const c of r.when.filter((c) => c.op === "le" && !c.negate)) {
      const v = c.value as number;
      const near = traces.map((t) => t.features[c.feature]).filter((x): x is number => typeof x === "number" && Math.abs(x - v) <= 1);
      if (near.length < 2) {
        qs.push({ about: c.feature, question: `The cut-off for ${c.feature} was learned as ${renderCondition(c)}, but almost no cases fell right at the edge. Where exactly do you draw the line?` });
      }
    }
  }
  // Her own exceptions: cases where she went against the rule that covers them (first five).
  for (const t of traces.filter((t) => { const r = matchingRule(proc, t); return r && r.action !== t.decision.action; }).slice(0, 5)) {
    const rule = matchingRule(proc, t)!;
    qs.push({ about: t.case_id, question: `On ${t.case_id} (${t.observed_on}) you chose ${t.decision.action} where you usually choose ${rule.action}. Was there a reason, or a slip?` });
  }
  const seen = new Set<string>();
  return qs.filter((q) => (seen.has(q.question) ? false : (seen.add(q.question), true)));
}

function matchingRule(proc: Procedure, t: Trace) {
  return proc.rules.find((r) => r.when.every((c) => holds(c, t.features[c.feature] ?? null)));
}
function matches(proc: Procedure, id: string, t: Trace) {
  return matchingRule(proc, t)?.id === id;
}

export function templateSop(proc: Procedure): Sop {
  return {
    title: "Pre-visit insurance check (learned procedure)",
    steps: proc.rules.map((r) => ({ rule_ids: [r.id], instruction: `If ${r.when.map(renderCondition).join(" and ") || "always"}: ${ACTION_TEXT[r.action]}` })),
    questions_for_worker: [],
    caveats: [
      `Learned from ${proc.learned_from.traces} observed cases between ${proc.learned_from.first_day} and ${proc.learned_from.last_day}.`,
      "Cases the replica has not seen the like of go to a person.",
    ],
  };
}

export type ExplainResult = { writer: "llm" | "template"; sop: Sop; questions: Question[]; fallbackReason?: string; estCostUsd?: number };

export async function explain(proc: Procedure, traces: Trace[]): Promise<ExplainResult> {
  const questions = evidenceQuestions(proc, traces);
  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (err) {
    return { writer: "template", sop: templateSop(proc), questions, fallbackReason: `no Claude credentials (${(err as Error).message})` };
  }

  const prompt = [
    "A front-desk lead was observed doing pre-visit insurance checks. A decision tree learned her process. Rules:",
    ...proc.rules.map(renderRule),
    "",
    `What each action means: ${JSON.stringify(ACTION_TEXT)}`,
    `Fields she looked at (share of cases): ${proc.domains.map((d) => `${d.name} ${(d.attention * 100).toFixed(0)}%`).join(", ")}. Never looked at: ${proc.ignored.join(", ") || "none"}.`,
    `Rules with fewer than ${proc.abstain.min_support} cases or under ${proc.abstain.min_agreement * 100}% agreement are escalated to a person.`,
    "",
    "Write a short SOP a clinic manager could review: merge rules that say the same thing, order steps the way a person would work a case, and cite rule ids on every step.",
    "Then list questions for the worker about what the observations cannot settle. In particular, look for situations where two rules could both seem to apply but never came up together in the data, and ask which comes first.",
    "Do not invent rules that are not in the list. Plain words, no jargon.",
  ].join("\n");

  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: "medium", format: betaZodOutputFormat(SopSchema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const estCostUsd = Math.round(((response.usage.input_tokens * PRICE.input + response.usage.output_tokens * PRICE.output) / 1e6) * 1e6) / 1e6;
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return { writer: "template", sop: templateSop(proc), questions, fallbackReason: `model returned no usable SOP (${response.stop_reason})`, estCostUsd };
    }
    const sop = response.parsed_output;
    const ids = new Set(proc.rules.map((r) => r.id));
    const bad = sop.steps.flatMap((s) => s.rule_ids).filter((id) => !ids.has(id));
    if (bad.length || sop.steps.some((s) => s.rule_ids.length === 0)) {
      return { writer: "template", sop: templateSop(proc), questions, fallbackReason: `SOP cited unknown or no rules (${bad.join(", ") || "empty"})`, estCostUsd };
    }
    return { writer: "llm", sop, questions: [...sop.questions_for_worker, ...questions], estCostUsd };
  } catch (err) {
    const msg = (err as Error).message;
    const reason = err instanceof Anthropic.APIError ? `Claude API ${err.status ?? "error"}` : /authentication/i.test(msg) ? "no Claude credentials" : msg.split(". ")[0]!;
    return { writer: "template", sop: templateSop(proc), questions, fallbackReason: reason };
  }
}

export function sopMarkdown(r: ExplainResult): string {
  return [
    `# ${r.sop.title}`,
    "",
    `_Written by: ${r.writer}${r.fallbackReason ? ` (fallback: ${r.fallbackReason})` : ""}_`,
    "",
    "## Steps",
    ...r.sop.steps.map((s, i) => `${i + 1}. ${s.instruction} _(${s.rule_ids.join(", ")})_`),
    "",
    "## Questions for the worker",
    ...(r.questions.length ? r.questions.map((q) => `- **${q.about}**: ${q.question}`) : ["- none"]),
    "",
    "## Caveats",
    ...r.sop.caveats.map((c) => `- ${c}`),
    "",
  ].join("\n");
}
