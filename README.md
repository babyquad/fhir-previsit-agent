# FHIR Pre-Visit Agent

A small agent that does one front-desk job: before patients arrive, check that every upcoming visit has insurance on file that is active on the visit date, and give staff a worklist of the visits that need action.

It runs against a real FHIR R4 server (the public HAPI sandbox by default) loaded with synthetic patients.

```
$ bun run worklist
5 upcoming visits in the next 14 days; 3 need action before the patient arrives.
- 2026-10-21 Linda Chen: NO_COVERAGE_ON_FILE. No insurance on file. Collect insurance details or start the self-pay conversation.
- 2026-10-23 James Okafor: EXPIRES_BEFORE_VISIT. Coverage on file ends before the visit. Ask the patient for their current insurance card before the visit.
- 2026-10-26 Robert Haynes: NOT_ACTIVE. Coverage on file is not active. Confirm current insurance with the patient or discuss self-pay.
(Coverage is what is on file in the EHR, not a live payer check.)
```

## How it works

| Piece | File | What it does |
|---|---|---|
| FHIR client | `src/fhir.ts` | Search with paging (capped), timeouts, retries on 429/5xx with `Retry-After`, OperationOutcome errors surfaced with the server's diagnostics. Every search is scoped to the demo tag. |
| Workflow | `src/previsit.ts` | Appointment + Coverage lookups and a pure `classify()` that decides OK / EXPIRES_BEFORE_VISIT / NOT_ACTIVE / NO_COVERAGE_ON_FILE. |
| Tools | `src/tools.ts` | Four read-only tools, zod-validated, shared by the agent and the MCP server. |
| Agent | `src/agent.ts` | Claude plans the tool calls (manual tool-use loop). With no credentials, or on any model error, a deterministic planner takes over, so the worklist never depends on the model being up. |
| MCP server | `mcp/server.ts` | The same tools over stdio for any MCP client, marked `readOnlyHint`. |
| Audit log | `src/audit.ts` | One JSON line per FHIR request: method, resource type, parameter names, count, latency. Never the values. |

## Guardrails

- **Read-only.** No tool writes to the EHR or contacts a patient. Outputs are recommendations for staff.
- **Minimum necessary.** Tools return only what the task needs: name, birth year, visit date and reason, payer, plan, coverage period, last 4 of the member id. Address, phone and full member id never reach the model (tested).
- **Untrusted model output.** Tool inputs are validated before they run. A `patient_id` like `p1&_tag=other` is rejected, so the model cannot widen a query.
- **Ambiguity goes to a human.** If a name matches more than one patient, the agent asks which one instead of guessing.
- **Honest scope.** This checks coverage on file. A real eligibility check asks the payer (X12 270/271, or a FHIR `CoverageEligibilityRequest`). That is the natural next step and is not built here.

## Run it

```bash
bun install
bun run seed                      # load the synthetic schedule (idempotent; re-run if the sandbox was wiped)
bun run worklist 14               # deterministic, no model
bun run ask "Who needs insurance follow-up this week?"
bun run ask "Is James Okafor covered for his visit?"
bun run ask "check Maria Alva"    # two patients match: the agent asks which one
bun test                          # 35 offline tests: fake FHIR server + fake Claude endpoint, no network, no spend
```

`bun run ask` uses Claude (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set and reports tokens and an estimated cost per run. Without a key it runs the deterministic planner and says so. Set `FHIR_BASE` to point at another R4 server.

## Replica from observation (`src/replica/`)

The worklist above is a process someone wrote down. This part learns one nobody wrote down: watch a top performer do the pre-visit check for weeks, extract her decision logic, then run that logic on new cases and hand anything unfamiliar back to a person.

```
$ bun run replica demo        # offline, under a second, no model needed
OBSERVE  4 weeks x 5 days x 15 cases: 300 traces, 5124 recorded events (fields opened, never values)
LEARN    from weeks 1-3 (225 traces)
  never opened, so not used: home_region
  R2: IF ... referral_on_file is false AND plan_type is HMO AND visit_type is one of {imaging, pre_op, specialist} THEN GET_REFERRAL  (35 cases, 97% agreement)
  R3: IF days_covered_after_visit <= 15 AND days_covered_after_visit > 0 THEN REMIND_AT_CHECKIN  (27 cases, 100% agreement)
EVAL     shadow mode on week 4
  weeks watched  agreement  escalated
              1      88.4%       8.0%
              2      91.8%       2.7%
              3      93.3%       0.0%
  gate: keep shadowing (bar is 95% agreement)
NOVEL    9 right, 1 handed to a person, 0 wrong
```

| Step | File | What it does |
|---|---|---|
| Watch | `recorder.ts`, `observe.ts` | A recording session sits between the worker and FHIR. Every search is a `read` event, and every field she actually opens (`Coverage.period`, `Appointment.serviceType`) is a `view` event, captured with a JS Proxy. Values are never recorded. Her decision is the Task she writes. |
| Perceive | `features.ts` | Turns an appointment into the contract's features (`days_covered_after_visit`, `plan_type`, `referral_on_file`, ...). Derived values only, no identifiers. |
| Learn | `learn.ts` | A small CART decision tree, written out so every step is inspectable. Only features she looked at are candidates (attention filter). Thresholds and category groupings are learned, which is how "about two weeks" and "specialist, pre-op or imaging" appear without anyone typing them. |
| Act | `replica.ts` | Runs the learned rules on new cases. Escalates instead of guessing when a value was never seen (Medicaid), when a case fits two rules in a combination never observed, or when a rule rests on too few or inconsistent cases. Read-only by default; `--write-tasks` posts FHIR Tasks with intent `proposal`, never edits to the record. |
| Measure | `evaluate.ts` | Shadow-mode agreement on a held-out week, the learning curve by weeks watched, a promotion gate (95% agreement, at most 15% escalated), and a labor estimate from her observed minutes per case. |
| Explain | `explain.ts` | Claude writes a plain-English SOP from the rules (structured output, every step must cite a real rule id, otherwise rejected). Deterministic questions for the worker come from evidence: unseen combinations, thin rules, and the specific cases where she went against her own pattern. |

```bash
bun run replica demo                 # observe, learn, eval, explain (offline)
bun run replica seed-live            # write 10 new synthetic visits to the FHIR server (idempotent)
bun run replica run                  # the replica decides them over live FHIR
bun run replica run --write-tasks    # ...and posts a proposal Task per decision
```

The trace and procedure formats are a contract shared with a screen-based counterpart: see [docs/CONTRACT.md](docs/CONTRACT.md).

**Honest scope.**
- The worker is simulated (`expert.ts`), with a 4% slip rate. The learner never imports that file; it only sees her traces. "She would" in the output is that simulated policy, which a real deployment does not have: those become questions for the worker.
- The feature catalog is hand-built. In the real problem, discovering which features matter from raw screens and files is the hard part, and it is not solved here.
- Observation happens at the FHIR layer. In a clinic that means an API proxy or EHR audit logs, and plenty of work never touches FHIR, which is why a screen half exists.
- The tree is the right tool for a demo you can read line by line. It is not a claim that trees are how this scales.
- The Claude SOP path is tested against a fake API only; without credentials the template writer runs and says so.

## Data

All patients, visits and plans are invented ("Demo Health Plan A" etc.) and tagged `https://ragflo.com/fhir-demo|previsit-demo`. No real patient data is used anywhere.
