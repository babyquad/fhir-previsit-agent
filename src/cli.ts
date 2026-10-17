/**
 *   bun run worklist [days]          deterministic worklist, no model involved
 *   bun run ask "<question>"         the agent (Claude if configured, else heuristic)
 */

import { runAgent, formatWorklist } from "./agent";
import { auditEvents } from "./audit";
import { FhirClient } from "./fhir";
import { buildWorklist } from "./previsit";

const [command, ...rest] = process.argv.slice(2);
const fhir = new FhirClient();

if (command === "worklist") {
  const days = Number(rest[0] ?? 14);
  const items = await buildWorklist(fhir, days);
  console.log(formatWorklist(items, days));
} else if (command === "ask" && rest.length > 0) {
  const result = await runAgent(rest.join(" "), fhir);
  console.log(`planner: ${result.planner}${result.fallbackReason ? ` (${result.fallbackReason})` : ""}`);
  for (const s of result.steps) {
    console.log(`  step ${s.tool} ${JSON.stringify(s.input)} ${s.ms}ms ${s.ok ? "ok" : `ERROR ${s.error}`}`);
  }
  if (result.usage) {
    console.log(`  tokens in/out ${result.usage.inputTokens}/${result.usage.outputTokens}, est $${result.usage.estCostUsd}`);
  }
  console.log(`\n${result.answer}`);
} else {
  console.error('usage: bun run worklist [days]  |  bun run ask "<question>"');
  process.exit(2);
}

const events = auditEvents();
console.log(`\naudit: ${events.length} FHIR requests logged (values never logged)`);
