/**
 * Minimal FHIR R4 REST client.
 *
 * Only what the pre-visit workflow needs: search with paging, a transaction
 * for seeding, timeouts, bounded retries on 429/5xx, and an audit record for
 * every request. FHIR errors come back as OperationOutcome resources; they
 * are surfaced as FhirError with the server's own diagnostics.
 */

import { audit } from "./audit";

export const DEFAULT_BASE = "https://hapi.fhir.org/baseR4";

/** Every demo resource carries this tag, so searches never touch other people's sandbox data. */
export const DEMO_TAG = { system: "https://ragflo.com/fhir-demo", code: "previsit-demo" };
export const DEMO_TAG_PARAM = `${DEMO_TAG.system}|${DEMO_TAG.code}`;

export type Resource = { resourceType: string; id?: string; [key: string]: unknown };
export type Bundle = {
  resourceType: "Bundle";
  entry?: { resource?: Resource; response?: { status?: string } }[];
  link?: { relation: string; url: string }[];
};

export class FhirError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly diagnostics?: string,
  ) {
    super(message);
    this.name = "FhirError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FhirClientOptions = {
  base?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** Hard cap on Bundle pages followed per search, so one query can't walk a whole server. */
  maxPages?: number;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class FhirClient {
  readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxPages: number;

  constructor(opts: FhirClientOptions = {}) {
    this.base = (opts.base ?? process.env.FHIR_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 2;
    this.maxPages = opts.maxPages ?? 5;
  }

  /** Search one resource type and follow `next` links up to maxPages. */
  async search(resourceType: string, params: Record<string, string>): Promise<Resource[]> {
    const qs = new URLSearchParams({ ...params, _tag: DEMO_TAG_PARAM, _count: "50" });
    let url: string | undefined = `${this.base}/${resourceType}?${qs}`;
    const out: Resource[] = [];

    for (let page = 0; url && page < this.maxPages; page++) {
      const bundle = (await this.request("GET", url, resourceType, Object.keys(params))) as Bundle;
      for (const e of bundle.entry ?? []) if (e.resource) out.push(e.resource);
      url = bundle.link?.find((l) => l.relation === "next")?.url;
    }
    return out;
  }

  /** POST a transaction Bundle to the server root (used by the seed script only). */
  async transaction(bundle: Bundle): Promise<Bundle> {
    return (await this.request("POST", this.base, "Bundle", ["transaction"], bundle)) as Bundle;
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    resourceType: string,
    paramKeys: string[],
    body?: unknown,
  ): Promise<Resource> {
    const started = performance.now();
    let attempt = 0;

    while (true) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { Accept: "application/fhir+json", "Content-Type": "application/fhir+json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt++ < this.retries) {
          await backoff(attempt);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        audit({ method, resourceType, paramKeys, status: 0, ms: performance.now() - started, error: message });
        throw new FhirError(`network error talking to FHIR server: ${message}`, 0);
      }

      if (RETRYABLE.has(res.status) && attempt++ < this.retries) {
        await backoff(attempt, res.headers.get("retry-after"));
        continue;
      }

      const json = (await res.json().catch(() => ({}))) as Resource;
      const ms = performance.now() - started;

      if (!res.ok) {
        const diagnostics = operationOutcomeText(json);
        audit({ method, resourceType, paramKeys, status: res.status, ms, error: diagnostics });
        throw new FhirError(`FHIR ${method} ${resourceType} failed with ${res.status}`, res.status, diagnostics);
      }

      const count = json.resourceType === "Bundle" ? ((json as Bundle).entry?.length ?? 0) : 1;
      audit({ method, resourceType, paramKeys, status: res.status, ms, count });
      return json;
    }
  }
}

function operationOutcomeText(json: Resource): string | undefined {
  if (json.resourceType !== "OperationOutcome") return undefined;
  const issues = (json.issue as { diagnostics?: string; details?: { text?: string } }[] | undefined) ?? [];
  return issues.map((i) => i.diagnostics ?? i.details?.text).filter(Boolean).join("; ") || undefined;
}

async function backoff(attempt: number, retryAfter?: string | null) {
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 10_000) : 250 * 2 ** attempt;
  await new Promise((r) => setTimeout(r, ms));
}
