/**
 * Glue for the offline pipeline: build an in-memory clinic, have the
 * simulated worker work it for N weeks, return her traces.
 */

import { FhirClient } from "../fhir";
import { makeExpert } from "./expert";
import { memFhir } from "./memfhir";
import { observe } from "./observe";
import { REPLICA_TAG_PARAM, generatePopulation, toResources, workdays, type CaseSpec } from "./population";

export const OBSERVATION_START = "2026-09-07"; // a Monday

export async function simulateObservation(opts: { weeks: number; perDay: number; seed?: number; noise?: number; start?: string }) {
  const days = workdays(opts.start ?? OBSERVATION_START, opts.weeks);
  const specs = generatePopulation({ seed: opts.seed ?? 42, days, perDay: opts.perDay, prefix: "obs" });
  return observeSpecs(specs, opts.noise);
}

export async function observeSpecs(specs: CaseSpec[], noise?: number, workerId = "front-desk-lead-01") {
  const { resources, cases } = toResources(specs);
  const server = memFhir(resources, REPLICA_TAG_PARAM);
  const fhir = new FhirClient({ base: "http://mem/fhir", fetch: server.fetch, tag: REPLICA_TAG_PARAM });
  return observe(fhir, cases, workerId, makeExpert(11, noise));
}
