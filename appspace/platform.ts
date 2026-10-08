import { z } from "npm:zod@4.3.6";
import {
  appspaceGetRaw,
  AppspaceGlobalArgsSchema,
  sanitizeId,
} from "./_client.ts";

const HTTP_VERBS = ["get", "post", "put", "patch", "delete"] as const;

/** Keywords searched for in every spec's raw text; only hit counts are kept. */
const DEFAULT_KEYWORDS = [
  "webhook",
  "broadcast",
  "passport",
  "analytics",
  "proof of play",
  "proofofplay",
  "report",
  "assistant",
  "copilot",
  "intelligence",
  "mcp",
  "model provider",
  "llm",
  "openai",
  "generate",
  "subscription",
  "event",
  "trigger",
  "connector",
  "release",
];

const ServiceSpecSchema = z.object({
  service: z.string(),
  specPath: z.string(),
  source: z.enum(["swagger-index", "candidate"]),
  indexName: z.string().nullable(),
  httpStatus: z.number(),
  isOpenApi: z.boolean(),
  title: z.string().nullable(),
  version: z.string().nullable(),
  openapiVersion: z.string().nullable(),
  labeledBeta: z.boolean(),
  betaEvidence: z.string().nullable(),
  serverUrls: z.array(z.string()),
  tags: z.array(z.string()),
  operationCounts: z.record(z.string(), z.number()),
  operations: z.array(z.string()),
  keywordHits: z.record(z.string(), z.number()),
  keywordContexts: z.record(z.string(), z.array(z.string())),
  bodyPreview: z.string().nullable(),
  fetchedAt: z.string(),
}).passthrough();

const PlatformSummarySchema = z.object({
  baseUrl: z.string(),
  indexStatus: z.number(),
  indexedServices: z.array(z.object({ name: z.string(), url: z.string() })),
  candidatesTried: z.array(z.string()),
  specsFound: z.array(z.string()),
  betaServices: z.array(z.string()),
  gaServices: z.array(z.string()),
  totalOperations: z.number(),
  fetchedAt: z.string(),
}).passthrough();

const ProbeResultSchema = z.object({
  path: z.string(),
  method: z.literal("GET"),
  httpStatus: z.number(),
  contentType: z.string(),
  shape: z.record(z.string(), z.unknown()),
  enumValues: z.record(z.string(), z.array(z.string())),
  errorSummary: z.string().nullable(),
  probedAt: z.string(),
}).passthrough();

/**
 * Summarise a JSON response without retaining field values: top-level keys,
 * array lengths, `totalCount`, and the union of keys on list items. Values
 * are only kept for the explicitly named `enumFields`, and only when they are
 * short strings (type/category labels, not free text).
 */
function summariseShape(
  body: unknown,
  enumFields: string[],
): { shape: Record<string, unknown>; enumValues: Record<string, string[]> } {
  const enumValues: Record<string, Set<string>> = {};
  for (const f of enumFields) enumValues[f] = new Set();

  const collect = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const f of enumFields) {
      const v = (item as Record<string, unknown>)[f];
      if (typeof v === "string" && v.length <= 64) enumValues[f].add(v);
      if (typeof v === "number" || typeof v === "boolean") {
        enumValues[f].add(String(v));
      }
      if (Array.isArray(v)) {
        for (const x of v) {
          if (typeof x === "string" && x.length <= 64) enumValues[f].add(x);
        }
      }
    }
  };

  const itemKeys = (arr: unknown[]) => {
    const keys = new Set<string>();
    for (const it of arr) {
      collect(it);
      if (it && typeof it === "object" && !Array.isArray(it)) {
        for (const k of Object.keys(it)) keys.add(k);
      }
    }
    return [...keys].sort();
  };

  let shape: Record<string, unknown>;
  // `$items` opts in to recording a top-level array of short strings
  // (e.g. an event-type catalogue returned as a bare list).
  if (Array.isArray(body) && enumFields.includes("$items")) {
    enumValues["$items"] = new Set(
      body.filter((x): x is string => typeof x === "string" && x.length <= 64),
    );
  }

  if (body === null || body === undefined) {
    shape = { kind: "empty" };
  } else if (Array.isArray(body)) {
    shape = { kind: "array", length: body.length, itemKeys: itemKeys(body) };
  } else if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    collect(obj);
    const arrays: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        arrays[k] = { length: v.length, itemKeys: itemKeys(v) };
      }
    }
    shape = {
      kind: "object",
      topLevelKeys: Object.keys(obj).sort(),
      totalCount: typeof obj.totalCount === "number" ? obj.totalCount : null,
      arrays,
    };
  } else {
    const text = String(body);
    shape = {
      kind: "text",
      length: text.length,
      looksLikeHtml: /<html|<!doctype/i.test(text),
    };
  }

  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(enumValues)) out[k] = [...v].sort();
  return { shape, enumValues: out };
}

/** Short, secret-free error text: the API's `message`/`title` fields only. */
function errorSummary(body: unknown): string | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    const msg = o.message ?? o.title ?? o.error ?? o.errorMessage;
    if (typeof msg === "string") return msg.slice(0, 200);
    return null;
  }
  if (typeof body === "string") {
    return /<html|<!doctype/i.test(body) ? "(html body)" : body.slice(0, 200);
  }
  return null;
}

/**
 * `@dougschaefer/appspace-platform` model — read-only capability discovery
 * for an Appspace tenant. `discover` enumerates the services listed in the
 * public Swagger UI index plus any candidate service slugs, fetches each
 * service's self-describing OpenAPI document, and records title, version,
 * BETA labelling and every operation. `probe` issues GET requests against an
 * explicit allow-list of paths and records status code and response shape
 * only. Neither method can issue anything but GET.
 */
export const model = {
  type: "@dougschaefer/appspace-platform",
  version: "2026.10.08.2",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    serviceSpec: {
      description:
        "One Appspace API service's OpenAPI summary — title, version, BETA label, operations, keyword hits",
      schema: ServiceSpecSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    platformSummary: {
      description:
        "Roll-up of a discovery pass — indexed services, BETA vs GA split, operation totals",
      schema: PlatformSummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    probeResult: {
      description:
        "Result of a read-only GET probe — HTTP status and response shape, never field values",
      schema: ProbeResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    discover: {
      description:
        "Enumerate Appspace API services from the Swagger UI index (plus optional candidate slugs), fetch each OpenAPI spec, and record title, version, BETA label and all operations. GET only.",
      arguments: z.object({
        candidateServices: z.array(z.string()).default([]).describe(
          "Extra service slugs to try at /api/<apiVersion>/<slug>/openapi even though the index does not list them (e.g. webhooks, broadcasts, analytics)",
        ),
        apiVersion: z.string().default("v3").describe(
          "API version segment used for the index and candidate spec paths",
        ),
        keywords: z.array(z.string()).optional().describe(
          "Keywords to count in each spec's raw text (defaults cover webhooks, broadcasts, passports, analytics, AI)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const now = new Date().toISOString();
        const keywords = args.keywords ?? DEFAULT_KEYWORDS;

        const index = await appspaceGetRaw(
          `/api/${args.apiVersion}/docs/`,
          g,
          { authenticated: false },
        );
        const indexed: Array<{ name: string; url: string }> = [];
        if (typeof index.body === "string") {
          const re = /\{\s*url:\s*"([^"]+)",\s*name:\s*"([^"]+)"\s*\}/g;
          for (const m of index.body.matchAll(re)) {
            indexed.push({ url: m[1], name: m[2] });
          }
        }
        context.logger.info(
          "Swagger index returned {status} listing {n} services",
          { status: index.status, n: indexed.length },
        );

        const targets: Array<{
          specPath: string;
          indexName: string | null;
          source: "swagger-index" | "candidate";
        }> = indexed.map((s) => ({
          specPath: s.url,
          indexName: s.name,
          source: "swagger-index",
        }));
        const known = new Set(targets.map((t) => t.specPath));
        for (const slug of args.candidateServices) {
          const specPath = `/api/${args.apiVersion}/${slug}/openapi`;
          if (known.has(specPath)) continue;
          known.add(specPath);
          targets.push({ specPath, indexName: null, source: "candidate" });
        }

        const handles = [];
        const specsFound: string[] = [];
        const beta: string[] = [];
        const ga: string[] = [];
        let totalOps = 0;

        for (const t of targets) {
          const service = t.specPath.split("/").slice(-2, -1)[0] ?? t.specPath;
          const res = await appspaceGetRaw(t.specPath, g);
          const doc = res.body && typeof res.body === "object"
            ? res.body as Record<string, unknown>
            : null;
          const isOpenApi = !!doc && (typeof doc.openapi === "string" ||
            typeof doc.swagger === "string") &&
            typeof doc.paths === "object";

          const info = (doc?.info ?? {}) as Record<string, unknown>;
          const operations: string[] = [];
          const opCounts: Record<string, number> = {};
          if (isOpenApi) {
            const paths = doc!.paths as Record<string, Record<string, unknown>>;
            for (const [p, item] of Object.entries(paths)) {
              for (const verb of HTTP_VERBS) {
                if (item && item[verb]) {
                  operations.push(`${verb.toUpperCase()} ${p}`);
                  opCounts[verb.toUpperCase()] =
                    (opCounts[verb.toUpperCase()] ?? 0) + 1;
                }
              }
            }
          }
          operations.sort();

          const rawText = typeof res.body === "string"
            ? res.body
            : JSON.stringify(res.body ?? "");
          const lower = rawText.toLowerCase();
          const keywordHits: Record<string, number> = {};
          const keywordContexts: Record<string, string[]> = {};
          if (isOpenApi) {
            for (const k of keywords) {
              keywordHits[k] = lower.split(k.toLowerCase()).length - 1;
              // Keep up to 5 short snippets per keyword so a hit can be
              // judged in context (specs are public documentation).
              const snippets: string[] = [];
              let at = lower.indexOf(k.toLowerCase());
              while (at !== -1 && snippets.length < 5) {
                snippets.push(
                  rawText.slice(Math.max(0, at - 60), at + k.length + 60)
                    .replace(/\s+/g, " "),
                );
                at = lower.indexOf(k.toLowerCase(), at + k.length);
              }
              if (snippets.length) keywordContexts[k] = snippets;
            }
          }

          let betaEvidence: string | null = null;
          if (t.indexName && /\bBETA\b/.test(t.indexName)) {
            betaEvidence = `index name: ${t.indexName}`;
          } else if (
            typeof info.description === "string" &&
            /\bBETA\b/.test(info.description)
          ) {
            betaEvidence = "info.description contains BETA disclaimer";
          } else if (
            typeof info.title === "string" && /\bBETA\b/.test(info.title)
          ) {
            betaEvidence = `info.title: ${info.title}`;
          }

          if (isOpenApi) {
            specsFound.push(service);
            (betaEvidence ? beta : ga).push(service);
            totalOps += operations.length;
          }

          const record = {
            service,
            specPath: t.specPath,
            source: t.source,
            indexName: t.indexName,
            httpStatus: res.status,
            isOpenApi,
            title: typeof info.title === "string" ? info.title : null,
            version: typeof info.version === "string" ? info.version : null,
            openapiVersion: typeof doc?.openapi === "string"
              ? doc.openapi as string
              : (typeof doc?.swagger === "string"
                ? doc.swagger as string
                : null),
            labeledBeta: !!betaEvidence,
            betaEvidence,
            serverUrls: Array.isArray(doc?.servers)
              ? (doc!.servers as Array<Record<string, unknown>>)
                .map((s) => String(s.url ?? ""))
              : [],
            tags: Array.isArray(doc?.tags)
              ? (doc!.tags as Array<Record<string, unknown>>)
                .map((s) => String(s.name ?? ""))
              : [],
            operationCounts: opCounts,
            operations,
            keywordHits,
            keywordContexts,
            bodyPreview: isOpenApi ? null : errorSummary(res.body),
            fetchedAt: now,
          };
          context.logger.info(
            "{service}: HTTP {status}, openapi={isOpenApi}, {ops} operations, beta={beta}",
            {
              service,
              status: res.status,
              isOpenApi,
              ops: operations.length,
              beta: !!betaEvidence,
            },
          );
          handles.push(
            await context.writeResource(
              "serviceSpec",
              sanitizeId(`${args.apiVersion}-${service}`),
              record,
            ),
          );
        }

        handles.push(
          await context.writeResource(
            "platformSummary",
            sanitizeId(`${args.apiVersion}-summary`),
            {
              baseUrl: g.baseUrl,
              indexStatus: index.status,
              indexedServices: indexed,
              candidatesTried: args.candidateServices,
              specsFound,
              betaServices: beta,
              gaServices: ga,
              totalOperations: totalOps,
              fetchedAt: now,
            },
          ),
        );
        return { dataHandles: handles };
      },
    },

    probe: {
      description:
        "Issue authenticated GET requests against an explicit allow-list of API paths and record HTTP status plus response shape (keys, counts). Never records field values except short strings from the named enumFields. GET only.",
      arguments: z.object({
        paths: z.array(z.string().startsWith("/")).min(1).max(50).describe(
          "Explicit allow-list of same-origin API paths (with optional query string) to GET",
        ),
        enumFields: z.array(z.string()).default([]).describe(
          "Field names (on the body or on list items) whose short string values may be recorded, e.g. type, eventType, providerType",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const handles = [];
        for (const path of args.paths) {
          const res = await appspaceGetRaw(path, g);
          const ok = res.status >= 200 && res.status < 300;
          const { shape, enumValues } = ok
            ? summariseShape(res.body, args.enumFields)
            : { shape: { kind: "error" }, enumValues: {} };
          context.logger.info("GET {path} -> {status}", {
            path,
            status: res.status,
          });
          handles.push(
            await context.writeResource(
              "probeResult",
              `get${sanitizeId(path)}`,
              {
                path,
                method: "GET" as const,
                httpStatus: res.status,
                contentType: res.contentType,
                shape,
                enumValues,
                errorSummary: ok ? null : errorSummary(res.body),
                probedAt: new Date().toISOString(),
              },
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
  },
};
