/**
 * Observation at the FHIR layer.
 *
 * A RecordingSession sits between a worker and the FHIR server. Every search
 * becomes a "read" event, and every resource handed back is wrapped so that
 * each FIELD the worker actually opens is recorded as a "view" event
 * ("Coverage.period", "Appointment.serviceType"). Values are never recorded,
 * only which fields were opened. A Task the worker writes is captured as their
 * decision.
 *
 * This is the FHIR counterpart of watching a screen: the screen half records
 * which panels and fields a worker looked at; this records which resources
 * and elements they pulled.
 */

import type { FhirClient, Resource } from "../fhir";
import type { Action, TraceEvent } from "./contract";

const SKIP = new Set(["resourceType", "id", "meta", "toJSON", "then", "constructor", "length"]);

export class RecordingSession {
  readonly events: TraceEvent[] = [];
  readonly viewed = new Set<string>();
  decision: { action: Action; note?: string } | null = null;
  /** Simulated human clock, advanced by the worker model (reading takes people time). */
  humanMs = 0;

  constructor(private readonly fhir: FhirClient) {}

  private log(kind: TraceEvent["kind"], target: string) {
    this.events.push({ t_ms: Math.round(this.humanMs), kind, target });
  }

  async search(type: string, params: Record<string, string>): Promise<Resource[]> {
    this.log("read", `${type}?${Object.keys(params).sort().join("&")}`);
    const rows = await this.fhir.search(type, params);
    return rows.map((r) => this.watch(r, type));
  }

  /** The worker's decision, written back as a FHIR Task the way staff would record it. */
  async writeDecision(task: Resource, action: Action, note?: string) {
    this.log("write", task.resourceType);
    this.decision = { action, note };
    // Recording only: during observation the decision is captured here, not pushed to a server.
  }

  private watch<T extends object>(obj: T, path: string): T {
    return new Proxy(obj, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (typeof key !== "string" || SKIP.has(key)) return value;
        // Array indexes don't name a field: Coverage.period, not Coverage.0.period.
        const next = /^\d+$/.test(key) || Array.isArray(target) ? path : `${path}.${key}`;
        if (next !== path && !this.viewed.has(next)) {
          this.viewed.add(next);
          this.log("view", next);
        }
        return value !== null && typeof value === "object" ? this.watch(value as object, next) : value;
      },
    });
  }
}

/**
 * Did the worker look at any of these targets? Prefix match: "Coverage.period"
 * covers "Coverage.period.end", and "Coverage?" covers any Coverage search.
 */
export function looked(events: TraceEvent[], targets: string[]): boolean {
  return events.some((e) => targets.some((t) => e.target.startsWith(t)));
}
