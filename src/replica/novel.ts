/**
 * Ten hand-built cases for the generalization check and the live demo.
 * Each one probes something the observation period did not show directly:
 * a plan type she never handled, exact threshold edges, and combinations
 * of situations that never came up together.
 *
 * `expected` is what the simulated worker would do (her policy without
 * slips). On a real deployment there is no such oracle: these become
 * questions for the worker.
 */

import type { Action } from "./contract";
import { addDays, type CaseSpec } from "./population";

export type NovelCase = { spec: CaseSpec; probe: string; expected: Action | "ESCALATE" };

export function novelCases(prefix: string, firstVisit: string): NovelCase[] {
  const day = (n: number) => addDays(firstVisit, n);
  const c = (k: number, visitType: string, referral: boolean, coverages: CaseSpec["coverages"], age = 52): CaseSpec => ({
    key: `${prefix}-${k}`, scenario: "novel", visitDate: day(k % 7), visitType, age, region: "north", referral, coverages,
  });
  return [
    { probe: "plan type never seen (Medicaid)", expected: "ESCALATE",
      spec: c(1, "follow_up", false, [{ status: "active", planType: "MEDICAID", startOffset: -120, endOffset: 200 }]) },
    { probe: "HMO specialist visit, no referral, coverage ends in 5 days (two rules collide)", expected: "GET_REFERRAL",
      spec: c(2, "imaging", false, [{ status: "active", planType: "HMO", startOffset: -300, endOffset: 5 }]) },
    { probe: "coverage ends exactly 14 days after the visit", expected: "REMIND_AT_CHECKIN",
      spec: c(3, "wellness", false, [{ status: "active", planType: "PPO", startOffset: -300, endOffset: 14 }]) },
    { probe: "coverage ends 16 days after the visit", expected: "NO_ACTION",
      spec: c(4, "follow_up", false, [{ status: "active", planType: "PPO", startOffset: -300, endOffset: 16 }]) },
    { probe: "two active policies on an HMO specialist visit", expected: "CONFIRM_PRIMARY",
      spec: c(5, "specialist", false, [
        { status: "active", planType: "HMO", startOffset: -200 },
        { status: "active", planType: "PPO", startOffset: -40, endOffset: 300 },
      ]) },
    { probe: "only a cancelled policy", expected: "CONFIRM_OR_SELF_PAY",
      spec: c(6, "new_patient", false, [{ status: "cancelled", planType: "PPO", startOffset: -500 }]) },
    { probe: "nothing on file", expected: "COLLECT_INSURANCE", spec: c(7, "new_patient", false, []) },
    { probe: "Medicare Advantage wellness, open-ended", expected: "NO_ACTION",
      spec: c(8, "wellness", false, [{ status: "active", planType: "MEDICARE_ADV", startOffset: -800 }], 74) },
    { probe: "HMO pre-op WITH a referral", expected: "NO_ACTION",
      spec: c(9, "pre_op", true, [{ status: "active", planType: "HMO", startOffset: -90, endOffset: 250 }]) },
    { probe: "coverage ended 2 days before the visit", expected: "REQUEST_NEW_CARD",
      spec: c(10, "follow_up", false, [{ status: "active", planType: "MEDICARE_ADV", startOffset: -400, endOffset: -2 }], 81) },
  ];
}
