/**
 * In-memory FHIR R4 server (just the search and create semantics the replica
 * uses), exposed as a `fetch` so FhirClient talks to it exactly as it talks
 * to HAPI. Three weeks of simulated observation run here in milliseconds;
 * the live replica run uses the real server.
 */

import type { Resource } from "../fhir";

export function memFhir(seed: Resource[], tag: string) {
  const store: Resource[] = seed.map((r) => structuredClone(r));
  let nextId = 1;

  const hasTag = (r: Resource) =>
    ((r.meta as { tag?: { system: string; code: string }[] } | undefined)?.tag ?? []).some((t) => `${t.system}|${t.code}` === tag);
  const refs = (r: Resource) => JSON.stringify([r.participant, r.beneficiary, r.subject, r.for]);

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const type = url.pathname.split("/").pop()!;

    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body)) as Resource;
      const created = { ...body, id: body.id ?? `mem-${nextId++}` };
      store.push(created);
      return Response.json(created, { status: 201 });
    }

    const p = url.searchParams;
    if (p.get("_tag") !== tag) {
      return Response.json({ resourceType: "OperationOutcome", issue: [{ diagnostics: "searches must be scoped to the demo tag" }] }, { status: 400 });
    }
    let rows = store.filter((r) => r.resourceType === type && hasTag(r));
    if (p.has("_id")) rows = rows.filter((r) => r.id === p.get("_id"));
    for (const key of ["patient", "beneficiary", "subject"]) {
      if (p.has(key)) rows = rows.filter((r) => refs(r).includes(`"${p.get(key)}"`));
    }
    if (p.has("status")) rows = rows.filter((r) => r.status === p.get("status"));
    if (p.has("date")) {
      const from = p.get("date")!.replace(/^ge/, "");
      rows = rows.filter((r) => String(r.start).slice(0, 10) >= from);
    }
    return Response.json({ resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource })) });
  };

  return { fetch: fetchImpl, store };
}
