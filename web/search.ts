// web_search's engines, tried in order until one answers with results. With a key or a server of
// your own they come first (SEARXNG_URL, BRAVE_API_KEY: real APIs, never blocked); then the ones
// that need nothing: Bing's RSS feed (plain XML, rarely blocked), Bing's page, DuckDuckGo's page,
// Marginalia's public API. One that turns kinoko away (429, a bot check) rests a few minutes.

import { decodeEntities, inline } from "./html.ts";

export const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
/** A web server that never answers must not hold the run; Esc still cuts it sooner. */
export const TIMEOUT_MS = 20_000;
/** An engine slower than this is skipped: the next one is likely quicker. */
const ENGINE_MS = 8_000;
/** Engines send whole paragraphs; a result only needs enough to choose what to fetch. */
const SNIPPET_CHARS = 300;
/** How long an engine that turned kinoko away is left alone. */
const REST_MS = 10 * 60_000;

export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

export interface Query {
  q: string;
  max: number;
  /** A market like "es-ES"; engines that know regions use it. */
  region?: string;
}

export interface Engine {
  name: string;
  request: (query: Query) => { url: string; headers?: Record<string, string> };
  parse: (body: string) => Hit[];
}

const enc = encodeURIComponent;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** JSON results: an array somewhere in the body, each with a URL, a title and a snippet field. */
function jsonHits(body: string, list: (data: Record<string, unknown>) => unknown, snippet: string): Hit[] {
  try {
    const items = list(record(JSON.parse(body)));
    if (!Array.isArray(items)) return [];
    return items
      .map((raw) => record(raw))
      .map((r) => ({ title: inline(str(r.title)), url: str(r.url), snippet: inline(str(r[snippet])) }))
      .filter((h) => /^https?:\/\//.test(h.url));
  } catch {
    return [];
  }
}

/** Bing's RSS: <item><title/><link/><description/></item>, the real URLs, no redirects. */
export function parseBingRss(xml: string): Hit[] {
  const hits: Hit[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const field = (tag: string): string => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? "";
    const url = decodeEntities(field("link"));
    if (/^https?:\/\//.test(url)) hits.push({ title: inline(field("title")), url, snippet: inline(field("description")) });
  }
  return hits;
}

/** Bing's page: links go through /ck/a?...&u=a1<base64url of the real URL>. */
export function parseBing(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const raw of html.split('<li class="b_algo"').slice(1)) {
    const block = raw.slice(0, raw.indexOf("</li>"));
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const href = decodeEntities(link[1] ?? "");
    const encoded = /[?&]u=a1([^&]+)/.exec(href)?.[1];
    const url = encoded ? Buffer.from(encoded, "base64url").toString() : href;
    const snippet = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "";
    if (/^https?:\/\//.test(url)) hits.push({ title: inline(link[2] ?? ""), url, snippet: inline(snippet) });
  }
  return hits;
}

/** DuckDuckGo's HTML results: links go through its /l/?uddg= redirect, which holds the real URL. */
export function parseDuckDuckGo(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split(/class="result results_links/).slice(1)) {
    if (block.includes("result--ad")) continue;
    const link = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const href = decodeEntities(link[1] ?? "");
    const real = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    const url = real ? decodeURIComponent(real) : href.startsWith("//") ? `https:${href}` : href;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
    if (/^https?:\/\//.test(url)) hits.push({ title: inline(link[2] ?? ""), url, snippet: inline(snippet) });
  }
  return hits;
}

export const parseSearxng = (body: string): Hit[] => jsonHits(body, (d) => d.results, "content");
export const parseBraveApi = (body: string): Hit[] => jsonHits(body, (d) => record(d.web).results, "description");
/** Marginalia sends no title for some pages: the URL stands in. */
export const parseMarginalia = (body: string): Hit[] => jsonHits(body, (d) => d.results, "description").map((h) => ({ title: h.title || h.url, url: h.url, snippet: h.snippet }));

/** Bing's market. Without one Bing follows the IP's country: English queries came back half in Spanish. */
const mkt = (region?: string): string => enc(region ?? "en-US");

/** The engines for this environment, in the order they are tried. */
export function engines(env: Record<string, string | undefined> = process.env): Engine[] {
  const list: Engine[] = [];
  const searx = env.SEARXNG_URL?.replace(/\/+$/, "");
  if (searx) {
    list.push({
      name: "searxng",
      request: ({ q, region }) => ({ url: `${searx}/search?format=json&q=${enc(q)}${region ? `&language=${enc(region)}` : ""}` }),
      parse: parseSearxng,
    });
  }
  const brave = env.BRAVE_API_KEY;
  if (brave) {
    list.push({
      name: "brave",
      request: ({ q, max, region }) => ({
        url: `https://api.search.brave.com/res/v1/web/search?q=${enc(q)}&count=${Math.min(max, 20)}${region?.includes("-") ? `&country=${enc(region.split("-")[1] ?? "")}` : ""}`,
        headers: { accept: "application/json", "x-subscription-token": brave },
      }),
      parse: parseBraveApi,
    });
  }
  list.push(
    { name: "bing", request: ({ q, region }) => ({ url: `https://www.bing.com/search?format=rss&q=${enc(q)}&mkt=${mkt(region)}` }), parse: parseBingRss },
    { name: "bing-page", request: ({ q, region }) => ({ url: `https://www.bing.com/search?q=${enc(q)}&mkt=${mkt(region)}` }), parse: parseBing },
    { name: "duckduckgo", request: ({ q }) => ({ url: `https://html.duckduckgo.com/html/?q=${enc(q)}` }), parse: parseDuckDuckGo },
    { name: "marginalia", request: ({ q, max }) => ({ url: `https://api.marginalia.nu/public/search/${enc(q)}?count=${Math.min(max, 20)}` }), parse: parseMarginalia },
  );
  return list;
}

/** Engines resting after turning kinoko away: name → when they may be asked again. */
const resting = new Map<string, number>();

function clip(text: string): string {
  return text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS).trimEnd()}…`;
}

function format(hits: Hit[], engine: string): string {
  const rows = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${clip(h.snippet)}` : ""}`);
  return `${rows.join("\n")}\n\n(via ${engine}; read a result with web_fetch)`;
}

/** The first engine that answers with results wins. A refusal (429, 403, a 202 bot check) rests
 *  that engine; when every engine rests, all are tried anyway. */
export async function search(query: Query, signal: AbortSignal, list = engines(), now = Date.now): Promise<string> {
  const awake = list.filter((e) => (resting.get(e.name) ?? 0) <= now());
  const order = awake.length > 0 ? awake : list;
  const failures: string[] = [];
  for (const engine of order) {
    try {
      const { url, headers } = engine.request(query);
      // oxlint-disable-next-line no-await-in-loop -- engines are a fallback chain, one at a time by design
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8", ...headers },
        signal: AbortSignal.any([signal, AbortSignal.timeout(ENGINE_MS)]),
      });
      // oxlint-disable-next-line no-await-in-loop -- same chain: the body of the engine just asked
      const body = await res.text();
      const hits = res.status === 200 ? dedupe(engine.parse(body)).slice(0, query.max) : [];
      if (hits.length > 0) {
        resting.delete(engine.name);
        return format(hits, engine.name);
      }
      if ([202, 403, 429].includes(res.status)) resting.set(engine.name, now() + REST_MS);
      failures.push(`${engine.name}: ${res.status === 200 ? "no results" : `HTTP ${res.status}`}`);
    } catch (e) {
      if (signal.aborted) throw e;
      failures.push(`${engine.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return `ERROR: web_search found nothing (${failures.join("; ")}). Try other words, or web_fetch a known URL.`;
}

/** The same page listed twice (with and without a trailing slash, say) shows once. */
function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = h.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Forgets which engines rest (tests). */
export function wake(): void {
  resting.clear();
}
