import { z } from "npm:zod@4.3.6";

/**
 * Shared Appspace v3 API client and schemas for extension models.
 *
 * Credentials are passed via globalArguments, typically resolved from vault:
 *   subjectId:    ${{ vault.get(appspace, subject-id) }}
 *   refreshToken: ${{ vault.get(appspace, refresh-token) }}
 *   baseUrl:      ${{ vault.get(appspace, base-url) }}  (e.g. https://appNN.cloud.appspace.com)
 *
 * Auth model: SubjectId + RefreshToken are exchanged at /api/v3/authorization/token
 * for a 1-hour Access Token (Bearer). This module caches the access token in-process
 * and refreshes 60s before expiry.
 */

export const AppspaceGlobalArgsSchema = z.object({
  subjectId: z.string().meta({ sensitive: true }).describe(
    "Appspace API token Subject ID (UUID). Use: ${{ vault.get(appspace, subject-id) }}",
  ),
  refreshToken: z.string().meta({ sensitive: true }).describe(
    "Appspace API token Refresh Token (UUID). Use: ${{ vault.get(appspace, refresh-token) }}",
  ),
  baseUrl: z
    .string()
    .default("https://api.cloud.appspace.com")
    .describe(
      "Appspace tenant base URL — public cloud is api.cloud.appspace.com, dedicated tenants use appNN.cloud.appspace.com",
    ),
});

export type AppspaceGlobalArgs = z.infer<typeof AppspaceGlobalArgsSchema>;

const tokenCache = new Map<
  string,
  { accessToken: string; expiresAt: number }
>();

async function getAccessToken(g: AppspaceGlobalArgs): Promise<string> {
  const cacheKey = `${g.baseUrl}|${g.subjectId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const url = new URL("/api/v3/authorization/token", g.baseUrl);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subjectType: "Application",
      subjectId: g.subjectId,
      grantType: "refreshToken",
      refreshToken: g.refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Appspace auth failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = await resp.json() as {
    accessToken: string;
    expiresIn: number;
  };

  tokenCache.set(cacheKey, {
    accessToken: data.accessToken,
    expiresAt: Date.now() + (data.expiresIn * 1000),
  });

  return data.accessToken;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export async function appspaceApi(
  path: string,
  g: AppspaceGlobalArgs,
  options: ApiOptions = {},
): Promise<unknown> {
  const token = await getAccessToken(g);
  const url = new URL(path, g.baseUrl);

  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const resp = await fetch(url.toString(), init);

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Appspace API ${resp.status} ${resp.statusText} (${
        options.method ?? "GET"
      } ${path}): ${body}`,
    );
  }

  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Page through a v3 list endpoint that uses start/limit pagination.
 * Stops when the API returns fewer items than `limit` or when `maxItems` is reached.
 */
export async function appspacePaged(
  path: string,
  g: AppspaceGlobalArgs,
  options: { params?: Record<string, string | number>; maxItems?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = 100;
  const maxItems = options.maxItems ?? Infinity;
  const results: Array<Record<string, unknown>> = [];
  let start = 0;

  while (results.length < maxItems) {
    const params = {
      ...(options.params ?? {}),
      start,
      limit: Math.min(limit, maxItems - results.length),
    };
    const page = await appspaceApi(path, g, { params }) as
      | { items?: Array<Record<string, unknown>>; totalCount?: number }
      | null;
    if (!page || !page.items || page.items.length === 0) break;
    results.push(...page.items);
    if (page.items.length < (params.limit as number)) break;
    start += page.items.length;
  }
  return results;
}

export function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
