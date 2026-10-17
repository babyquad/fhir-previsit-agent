/**
 * Append-only audit trail of every FHIR request.
 *
 * Records what was touched (method, resource type, which search parameters
 * were used, how many records came back, latency), never the values: patient
 * names and IDs stay out of the log. One JSON object per line.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEvent = {
  method: string;
  resourceType: string;
  paramKeys: string[];
  status: number;
  ms: number;
  count?: number;
  error?: string;
};

const path = process.env.AUDIT_LOG ?? "logs/audit.jsonl";
const sink: AuditEvent[] = [];

export function audit(event: AuditEvent) {
  const line = { at: new Date().toISOString(), ...event, ms: Math.round(event.ms) };
  sink.push(line);
  if (path === "off") return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n");
  } catch {
    // Best effort: a full disk must not take down a read path. The in-memory sink still has it.
  }
}

/** Events recorded by this process, for tests and the CLI summary. */
export function auditEvents(): readonly AuditEvent[] {
  return sink;
}
