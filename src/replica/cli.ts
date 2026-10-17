/**
 * Replica-from-observation CLI.
 *
 *   bun run replica demo               observe -> learn -> evaluate -> explain, all offline
 *   bun run replica observe [weeks]    simulate N weeks of a worker (default 4), write out/traces.jsonl
 *   bun run replica learn [weeks]      learn from the first N weeks (default 3), write out/procedure.json
 *   bun run replica eval               learning curve, shadow week, novel cases, labor estimate
 *   bun run replica explain            SOP + questions for the worker (Claude if configured), out/SOP.md
 *   bun run replica seed-live          write the 10 novel cases to the FHIR server (HAPI by default)
 *   bun run replica run [--write-tasks]  run the replica on those cases over the live server
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { auditEvents } from "../audit";
import { FhirClient } from "../fhir";
import { ESCALATE, Procedure, Trace, renderRule } from "./contract";
import { learn } from "./learn";
import { gate, laborEstimate, learningCurve, score, weekOf } from "./evaluate";
import { explain, sopMarkdown } from "./explain";
import { memFhir } from "./memfhir";
import { novelCases } from "./novel";
import { simulateObservation, OBSERVATION_START } from "./pipeline";
import { REPLICA_TAG_PARAM, addDays, toResources, toTransaction } from "./population";
import { decide, runReplica } from "./replica";

const OUT = process.env.REPLICA_OUT ?? "out";
const PER_DAY = 15;
const LIVE_PREFIX = "ragflo-rr-live";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

mkdirSync(OUT, { recursive: true });
const tracesPath = `${OUT}/traces.jsonl`;
const procPath = `${OUT}/procedure.json`;

const loadTraces = () => readFileSync(tracesPath, "utf8").trim().split("\n").map((l) => Trace.parse(JSON.parse(l)));
const loadProc = () => Procedure.parse(JSON.parse(readFileSync(procPath, "utf8")));
const split = (traces: Trace[], trainWeeks: number) => ({
  train: traces.filter((t) => weekOf(t, OBSERVATION_START) < trainWeeks),
  heldOut: traces.filter((t) => weekOf(t, OBSERVATION_START) >= trainWeeks),
});

async function cmdObserve(weeks: number) {
  const traces = await simulateObservation({ weeks, perDay: PER_DAY });
  writeFileSync(tracesPath, traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
  const events = traces.reduce((n, t) => n + t.events.length, 0);
  console.log(`OBSERVE  ${weeks} weeks x 5 days x ${PER_DAY} cases: ${traces.length} traces, ${events} recorded events (fields opened, never values) -> ${tracesPath}`);
  const t = traces[0]!;
  console.log(`  e.g. ${t.case_id}: ${t.events.map((e) => `${e.kind}:${e.target}`).slice(0, 8).join("  ")} ... -> ${t.decision.action}`);
}

function cmdLearn(trainWeeks: number) {
  const { train } = split(loadTraces(), trainWeeks);
  const proc = learn(train);
  writeFileSync(procPath, JSON.stringify(proc, null, 2) + "\n");
  console.log(`\nLEARN  from weeks 1-${trainWeeks} (${train.length} traces) -> ${procPath}`);
  console.log(`  looked at: ${proc.domains.map((d) => `${d.name} ${pct(d.attention)}`).join(", ")}`);
  console.log(`  never opened, so not used: ${proc.ignored.join(", ") || "none"}`);
  console.log(`  her median time per case: ${proc.human_minutes_per_case.toFixed(1)} min (simulated)`);
  for (const r of proc.rules) console.log(`  ${renderRule(r)}`);
}

async function cmdEval(trainWeeks: number) {
  const traces = loadTraces();
  const { train, heldOut } = split(traces, trainWeeks);
  const proc = loadProc();

  console.log(`\nEVAL  shadow mode on week ${trainWeeks + 1} (${heldOut.length} cases she worked; the replica decides in parallel and is compared)`);
  console.log("  weeks watched  traces  rules  agreement  escalated");
  for (const c of learningCurve(train, heldOut)) {
    console.log(`  ${String(c.weeks).padStart(13)}  ${String(c.traces).padStart(6)}  ${String(c.rules).padStart(5)}  ${pct(c.agreementOnDecided).padStart(9)}  ${pct(c.escalationRate).padStart(9)}`);
  }
  const s = score(proc, heldOut);
  const slips = heldOut.filter((t) => t.decision.note === "(slip)").map((t) => t.case_id);
  const missesOnSlips = s.misses.filter((m) => slips.includes(m.case_id)).length;
  console.log(`  disagreements: ${s.misses.length}, of which ${missesOnSlips} were her own slips (simulation-only check: in real life you would ask her)`);
  console.log(`  gate: ${gate(s).why}`);

  // Generalization: hand-built cases that probe what observation did not show.
  const novel = novelCases("novel", addDays(OBSERVATION_START, 7 * 5));
  const { resources, cases } = toResources(novel.map((n) => n.spec));
  const server = memFhir(resources, REPLICA_TAG_PARAM);
  const fhir = new FhirClient({ base: "http://mem/fhir", fetch: server.fetch, tag: REPLICA_TAG_PARAM });
  const items = await runReplica(fhir, proc, cases.map((c) => c.appointmentId));
  console.log(`\nNOVEL  ${novel.length} situations built to test generalization`);
  const tally = { right: 0, handedOff: 0, wrong: 0 };
  items.forEach((it, i) => {
    const n = novel[i]!;
    const verdict = it.decision.action === n.expected ? "right" : it.decision.action === ESCALATE ? "handedOff" : "wrong";
    tally[verdict]++;
    const label = { right: "ok   ", handedOff: "ASKED", wrong: "WRONG" }[verdict];
    console.log(`  ${label} ${n.probe}: replica ${it.decision.action} (${it.decision.reason})${verdict === "right" ? "" : `, she would ${n.expected}`}`);
  });
  console.log(`  ${tally.right} right, ${tally.handedOff} handed to a person, ${tally.wrong} wrong`);

  const labor = laborEstimate(proc, s, PER_DAY * 5);
  console.log(`\nLABOR (estimate)  at ${PER_DAY * 5} cases/week, the replica would decide ${pct(labor.autoShare)} of them; at her observed ${labor.minutesPerCase.toFixed(1)} min/case that is about ${labor.hoursPerWeek.toFixed(1)} staff hours/week. Tie this to a number the clinic already tracks before quoting it.`);
}

async function cmdExplain(trainWeeks: number) {
  const { train } = split(loadTraces(), trainWeeks);
  const r = await explain(loadProc(), train);
  writeFileSync(`${OUT}/SOP.md`, sopMarkdown(r));
  console.log(`\nEXPLAIN  writer: ${r.writer}${r.fallbackReason ? ` (${r.fallbackReason})` : ""}${r.estCostUsd ? `, est $${r.estCostUsd}` : ""} -> ${OUT}/SOP.md`);
  console.log(`  ${r.sop.steps.length} SOP steps, ${r.questions.length} questions for the worker. First questions:`);
  for (const q of r.questions.slice(0, 5)) console.log(`  - ${q.question}`);
}

function liveFhir() {
  return new FhirClient({ tag: REPLICA_TAG_PARAM });
}

function liveCases() {
  const today = new Date().toISOString().slice(0, 10);
  return novelCases(LIVE_PREFIX, addDays(today, 3));
}

async function cmdSeedLive() {
  const fhir = liveFhir();
  const { resources } = toResources(liveCases().map((n) => n.spec));
  console.log(`Seeding ${resources.length} synthetic resources (10 upcoming visits) into ${fhir.base}, tag ${REPLICA_TAG_PARAM}`);
  const result = await fhir.transaction(toTransaction(resources) as never);
  const tally = (result.entry ?? []).reduce<Record<string, number>>((acc, e) => ((acc[e.response?.status ?? "?"] = (acc[e.response?.status ?? "?"] ?? 0) + 1), acc), {});
  console.log("Server responses:", tally);
}

async function cmdRun(write: boolean) {
  const fhir = liveFhir();
  const proc = loadProc();
  const novel = liveCases();
  const { cases } = toResources(novel.map((n) => n.spec));
  console.log(`RUN  replica on ${cases.length} upcoming visits at ${fhir.base}${write ? " (writing staff Tasks)" : " (read-only; --write-tasks to post Tasks)"}`);
  const items = await runReplica(fhir, proc, cases.map((c) => c.appointmentId), { write });
  items.forEach((it, i) => {
    const tag = it.decision.action === ESCALATE ? "ESCALATE" : it.decision.action;
    const agree = it.decision.action === novel[i]!.expected ? "" : `   <- she would ${novel[i]!.expected}`;
    console.log(`  ${it.visitDay} ${it.patientName.padEnd(18)} ${tag.padEnd(20)} ${it.decision.reason} ${it.ms}ms${it.taskId ? ` Task/${it.taskId}` : ""}${agree}`);
  });
  const total = items.reduce((n, it) => n + it.ms, 0);
  console.log(`  ${items.length} cases in ${(total / 1000).toFixed(1)}s of FHIR time; escalated ${items.filter((i) => i.decision.action === ESCALATE).length}`);
}

const [cmd = "demo", ...args] = process.argv.slice(2);
const n = (i: number, d: number) => (args[i] && /^\d+$/.test(args[i]!) ? Number(args[i]) : d);

if (cmd === "observe") await cmdObserve(n(0, 4));
else if (cmd === "learn") cmdLearn(n(0, 3));
else if (cmd === "eval") await cmdEval(n(0, 3));
else if (cmd === "explain") await cmdExplain(n(0, 3));
else if (cmd === "seed-live") await cmdSeedLive();
else if (cmd === "run") await cmdRun(args.includes("--write-tasks"));
else if (cmd === "demo") {
  await cmdObserve(4);
  cmdLearn(3);
  await cmdEval(3);
  await cmdExplain(3);
} else {
  console.error("usage: bun run replica [demo|observe|learn|eval|explain|seed-live|run [--write-tasks]]");
  process.exit(2);
}

if (cmd === "seed-live" || cmd === "run") console.log(`\naudit: ${auditEvents().length} FHIR requests logged (values never logged)`);
