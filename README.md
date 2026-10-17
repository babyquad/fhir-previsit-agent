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
bun test                          # 21 offline tests: fake FHIR server + fake Claude endpoint, no network, no spend
```

`bun run ask` uses Claude (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set and reports tokens and an estimated cost per run. Without a key it runs the deterministic planner and says so. Set `FHIR_BASE` to point at another R4 server.

## Data

All patients, visits and plans are invented ("Demo Health Plan A" etc.) and tagged `https://ragflo.com/fhir-demo|previsit-demo`. No real patient data is used anywhere.
