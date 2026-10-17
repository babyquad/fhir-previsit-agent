# Replica contract v1

Source of truth: [`src/replica/contract.ts`](../src/replica/contract.ts) (zod schemas). This page explains it for the screen half, which lives in its own repo and should copy the schemas, not import across repos.

## The idea

Observation can come from two surfaces: FHIR (this repo) or the screen (the screen half). Both produce the same **Trace**. Learning produces a **Procedure** that names **features**, not endpoints or pixels. So a procedure learned from FHIR traces can be executed over the screen, and screen traces can be learned by the same learner.

```
 FHIR observation ─┐                         ┌─> execute over FHIR   (this repo)
                   ├─> Trace[] ─> learn() ─> Procedure ─┤
 screen observation┘                         └─> execute over screen (screen half)
```

## Features (the bridge)

Same names and meanings on both surfaces. The screen half implements the `screen` column.

| feature | type | FHIR source (implemented) | screen source (to bind) |
|---|---|---|---|
| coverage_on_file | bool | Coverage search | Insurance tab: any policy row |
| active_coverage | bool | Coverage.status | Insurance tab: Status column |
| days_covered_after_visit | number or null | Coverage.period | Insurance tab: term date vs appointment date |
| active_policies_on_visit | number | Coverage.status + period | Insurance tab: active rows covering the visit date |
| plan_type | category | Coverage.type | Insurance tab: Plan Type |
| visit_type | category | Appointment.serviceType | Appointment detail: Visit Type |
| referral_on_file | bool | ServiceRequest search | Referrals tab: any active row |
| patient_age | number | Patient.birthDate | Chart header: DOB |
| visit_weekday | category | Appointment.start | Appointment detail: date |
| home_region | category | Patient.address | Demographics: address |

Category values used so far: `plan_type` in HMO, PPO, MEDICARE_ADV (MEDICAID appears only in the novel set); `visit_type` in wellness, new_patient, follow_up, specialist, pre_op, imaging.

## Trace (`replica.trace/v1`)

```json
{
  "schema": "replica.trace/v1",
  "case_id": "obs-1",
  "worker_id": "front-desk-lead-01",
  "surface": "fhir",
  "observed_on": "2026-09-07",
  "duration_ms": 193938,
  "events": [
    { "t_ms": 0, "kind": "read", "target": "Appointment?_id" },
    { "t_ms": 90064, "kind": "view", "target": "Coverage.period.end" },
    { "t_ms": 193938, "kind": "write", "target": "Task" }
  ],
  "decision": { "action": "NO_ACTION", "note": "ok" },
  "features": { "coverage_on_file": true, "days_covered_after_visit": 290, "plan_type": "HMO", "...": "..." }
}
```

Rules:
- `events[].target` names WHAT was touched (a FHIR path, or a screen locator like `insurance_tab.term_date`). Never a value.
- `kind`: `read`, `view`, `click`, `type`, `navigate`, `write`.
- `features` hold derived values only: no names, ids, dates of birth or member ids.
- `decision.action` is one of: COLLECT_INSURANCE, CONFIRM_OR_SELF_PAY, REQUEST_NEW_CARD, CONFIRM_PRIMARY, GET_REFERRAL, REMIND_AT_CHECKIN, NO_ACTION.
- Attention: the learner only uses a feature if the worker looked at its source in at least 2% of traces. For screen traces, map each feature to the locators that count as "looked at" (for example `referrals_tab` opened means `referral_on_file` was looked at).

## Procedure (`replica.procedure/v1`)

Rules are leaves of the learned tree. Each has `when` (conditions), `action`, `support`, `agreement`, `examples`, and `conflicts` (combinations never observed under this rule that also fit a rule with a different action).

Condition ops: `eq` (bool or one category), `in` (a group of categories), `le` (numeric threshold), `missing`; `negate: true` means the other branch.

Executing a procedure (both surfaces must behave the same):
1. A category value never seen in training on a feature the rules use: ESCALATE.
2. Find the one rule whose conditions all hold.
3. If the case also meets all `extras` of one of that rule's `conflicts`: ESCALATE.
4. If `support < abstain.min_support` or `agreement < abstain.min_agreement`: ESCALATE.
5. Otherwise do `action`.

A ready procedure is at `out/procedure.json` after `bun run replica learn`.
