/**
 * Extract the worker's decision logic from her traces.
 *
 * A small CART decision tree (Gini impurity), written out here rather than
 * pulled from a library so every step is inspectable:
 *
 *   1. Attention filter: only features whose source she actually LOOKED AT
 *      are candidates. Data she had but never opened is not part of her
 *      process, so the replica doesn't use it either.
 *   2. Grow the tree: at each node, try every candidate split (a boolean,
 *      one category vs the rest, a numeric threshold, or "is missing") and
 *      keep the one that best separates her decisions. Thresholds are
 *      learned, which is how an unwritten "about two weeks" shows up as a
 *      number.
 *   3. Merge sibling leaves that reach the same decision, then read each
 *      leaf off as a rule with its support and agreement.
 *
 * Rules backed by too few cases, or where she was inconsistent, are kept
 * but marked: the replica escalates those to a human instead of acting.
 */

import {
  FEATURES,
  Procedure,
  type Action,
  type Condition,
  type FeatureValue,
  type Rule,
  type Trace,
} from "./contract";
import { looked } from "./recorder";

export type LearnOptions = {
  maxDepth?: number;
  minLeaf?: number;
  /** Below this share of traces, a feature counts as "never looked at". */
  minAttention?: number;
  abstain?: { min_support: number; min_agreement: number };
};

type Row = { f: Record<string, FeatureValue>; y: Action; id: string };
type Node =
  | { leaf: true; rows: Row[] }
  | { leaf: false; cond: Condition; yes: Node; no: Node };

export function learn(traces: Trace[], opts: LearnOptions = {}): Procedure {
  if (traces.length === 0) throw new Error("no traces to learn from");
  const maxDepth = opts.maxDepth ?? 8;
  const minLeaf = opts.minLeaf ?? 4;
  const minAttention = opts.minAttention ?? 0.02;
  const abstain = opts.abstain ?? { min_support: 5, min_agreement: 0.85 };

  // 1. attention
  const attention = new Map(FEATURES.map((spec) => [spec.name, traces.filter((t) => looked(t.events, spec.fhir)).length / traces.length]));
  const candidates = FEATURES.filter((f) => (attention.get(f.name) ?? 0) >= minAttention);
  const ignored = FEATURES.filter((f) => !candidates.includes(f)).map((f) => f.name);

  const rows: Row[] = traces.map((t) => ({ f: t.features, y: t.decision.action, id: t.case_id }));

  // 2. grow
  const grow = (rs: Row[], depth: number): Node => {
    if (depth >= maxDepth || rs.length < 2 * minLeaf || gini(rs) === 0) return { leaf: true, rows: rs };
    let best: { cond: Condition; gain: number; yes: Row[]; no: Row[] } | null = null;
    const parent = gini(rs);
    for (const spec of candidates) {
      for (const cond of splitsFor(spec.name, spec.type, rs)) {
        const yes = rs.filter((r) => holds(cond, r.f[cond.feature] ?? null));
        const no = rs.filter((r) => !holds(cond, r.f[cond.feature] ?? null));
        if (yes.length < minLeaf || no.length < minLeaf) continue;
        const gain = parent - (yes.length * gini(yes) + no.length * gini(no)) / rs.length;
        if (!best || gain > best.gain + 1e-12) best = { cond, gain, yes, no };
      }
    }
    if (!best || best.gain < 1e-3) return { leaf: true, rows: rs };
    return { leaf: false, cond: best.cond, yes: grow(best.yes, depth + 1), no: grow(best.no, depth + 1) };
  };
  const tree = merge(grow(rows, 0));

  // 3. read off rules
  const rules: Rule[] = [];
  const walk = (n: Node, path: Condition[]) => {
    if (n.leaf) {
      const { action, share } = majority(n.rows);
      rules.push({
        id: "",
        when: path,
        action,
        support: n.rows.length,
        agreement: round(share),
        examples: n.rows.filter((r) => r.y === action).slice(0, 5).map((r) => r.id),
        conflicts: [],
      });
      return;
    }
    walk(n.yes, [...path, n.cond]);
    walk(n.no, [...path, { ...n.cond, negate: !n.cond.negate }]);
  };
  walk(tree, []);
  rules.sort((a, b) => b.support - a.support).forEach((r, i) => (r.id = `R${i + 1}`));
  findConflicts(rules, rows);

  const days = traces.map((t) => t.observed_on).sort();
  const minutes = traces.map((t) => t.duration_ms / 60_000).sort((a, b) => a - b);

  return Procedure.parse({
    schema: "replica.procedure/v1",
    task: "previsit-coverage",
    learned_from: {
      traces: traces.length,
      workers: [...new Set(traces.map((t) => t.worker_id))],
      surfaces: [...new Set(traces.map((t) => t.surface))],
      first_day: days[0],
      last_day: days.at(-1),
    },
    domains: candidates.map((spec) => {
      const vals = rows.map((r) => r.f[spec.name] ?? null).filter((v) => v !== null);
      const nums = vals.filter((v): v is number => typeof v === "number");
      return {
        name: spec.name,
        type: spec.type,
        ...(spec.type === "category" ? { values: [...new Set(vals.map(String))].sort() } : {}),
        ...(spec.type === "number" && nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : {}),
        attention: round(attention.get(spec.name) ?? 0),
      };
    }),
    ignored,
    rules,
    abstain,
    human_minutes_per_case: round(minutes[Math.floor(minutes.length / 2)] ?? 0),
  });
}

// ---------- unseen combinations ----------

/**
 * A tree only tests what separated the cases it saw. Rule A ("coverage ends
 * within 15 days -> remind") never asks about plan type, because no HMO
 * specialist case without a referral ever ended that soon. If one shows up, A
 * would answer for it even though rule B ("HMO + specialist + no referral ->
 * get referral") also fits.
 *
 * For every pair of rules with different actions, take B's conditions on
 * features A does not test ("extras"). If no case observed under A ever met
 * all of them, record the conflict. Matching it at run time means escalate.
 */
function findConflicts(rules: Rule[], rows: Row[]) {
  const ruleOf = (r: Row) => rules.find((rule) => rule.when.every((c) => holds(c, r.f[c.feature] ?? null)));
  const byRule = new Map<string, Row[]>();
  for (const r of rows) {
    const rule = ruleOf(r);
    if (rule) byRule.set(rule.id, [...(byRule.get(rule.id) ?? []), r]);
  }
  for (const a of rules) {
    const tested = new Set(a.when.map((c) => c.feature));
    for (const b of rules) {
      if (b.id === a.id || b.action === a.action || b.action === "NO_ACTION") continue;
      const extras = b.when.filter((c) => !tested.has(c.feature));
      if (extras.length === 0) continue;
      const seenTogether = (byRule.get(a.id) ?? []).some((r) => extras.every((c) => holds(c, r.f[c.feature] ?? null)));
      if (!seenTogether) a.conflicts.push({ with: b.id, extras });
    }
  }
}

// ---------- tree helpers ----------

export function holds(c: Condition, v: FeatureValue): boolean {
  let r: boolean;
  if (c.op === "missing") r = v === null;
  else if (c.op === "in") r = typeof v === "string" && (c.value as string[]).includes(v);
  else if (c.op === "le") r = typeof v === "number" && v <= (c.value as number);
  else r = v === c.value;
  return c.negate ? !r : r;
}

function splitsFor(name: string, type: string, rs: Row[]): Condition[] {
  const vals = rs.map((r) => r.f[name] ?? null);
  const out: Condition[] = [];
  if (vals.some((v) => v === null) && vals.some((v) => v !== null)) out.push({ feature: name, op: "missing", negate: false });
  if (type === "bool") out.push({ feature: name, op: "eq", value: true, negate: false });
  if (type === "category") {
    // Every grouping of the values seen here (small sets only), so a rule can say
    // "specialist, pre-op or imaging" instead of testing one value at a time.
    const seen = [...new Set(vals.filter((x): x is string => typeof x === "string"))].sort();
    if (seen.length <= 8) {
      for (let mask = 1; mask < 2 ** seen.length - 1; mask++) {
        const subset = seen.filter((_, i) => mask & (2 ** i));
        if (subset.length > seen.length / 2) continue; // the complement covers it
        out.push(subset.length === 1 ? { feature: name, op: "eq", value: subset[0]!, negate: false } : { feature: name, op: "in", value: subset, negate: false });
      }
    } else {
      for (const v of seen) out.push({ feature: name, op: "eq", value: v, negate: false });
    }
  }
  if (type === "number") {
    const sorted = [...new Set(vals.filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) out.push({ feature: name, op: "le", value: (sorted[i]! + sorted[i + 1]!) / 2, negate: false });
  }
  return out;
}

function gini(rs: Row[]): number {
  if (rs.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const r of rs) counts.set(r.y, (counts.get(r.y) ?? 0) + 1);
  let g = 1;
  for (const c of counts.values()) g -= (c / rs.length) ** 2;
  return g;
}

function majority(rs: Row[]): { action: Action; share: number } {
  const counts = new Map<Action, number>();
  for (const r of rs) counts.set(r.y, (counts.get(r.y) ?? 0) + 1);
  const [action, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { action, share: n / rs.length };
}

/** Collapse a split whose two sides end in the same decision. */
function merge(n: Node): Node {
  if (n.leaf) return n;
  const yes = merge(n.yes);
  const no = merge(n.no);
  if (yes.leaf && no.leaf && majority(yes.rows).action === majority(no.rows).action) return { leaf: true, rows: [...yes.rows, ...no.rows] };
  return { ...n, yes, no };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
