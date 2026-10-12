// web_search: the engines (engines.ts) asked in turn until one answers with results worth reading.
// A scraped page's hits must share words with the query: Bing once answered a football question
// with a porn site. One that turns kinoko away (a bot check, a spent quota, a bad key) rests.

import type { Engine, Query } from "./engines.ts";
import { engines, readConfig } from "./engines.ts";
import type { Hit } from "./parsers.ts";

export const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
/** A web server that never answers must not hold the run; Esc still cuts it sooner. */
export const TIMEOUT_MS = 20_000;
/** An engine slower than this is skipped: the next one is likely quicker. */
const ENGINE_MS = 8_000;
/** Engines send whole paragraphs; a result only needs enough to choose what to fetch. */
const SNIPPET_CHARS = 300;
/** How long an engine that turned kinoko away is left alone. */
const REST_MS = 10 * 60_000;
/** Turned away: a bot check (202), refused (401, 403), out of quota (429; Tavily's plan limit, 432). */
const REFUSED = new Set([202, 401, 403, 429, 432]);

/** Words too common to say whether a page is about the query. */
const COMMON = new Set("the and for with what who how why when where are was were from this that your you not but can".split(" ").concat("que los las del una por con para como cual donde cuando".split(" ")));

const fold = (text: string): string => text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");

/** The query's telling words: three letters or more, not the commonest, no search operators. */
export function words(q: string): string[] {
  const plain = fold(q).replace(/\b(site|inurl|intitle|filetype):\S+/g, " ");
  return [...new Set(plain.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !COMMON.has(w)))];
}

/** A hit is about the query when it carries its words: one for a short query, two for a longer one. */
export function relevant(hit: Hit, telling: string[]): boolean {
  if (telling.length === 0) return true;
  const text = fold(`${hit.title} ${hit.snippet} ${hit.url}`);
  const found = telling.filter((w) => text.includes(w)).length;
  return found >= (telling.length >= 3 ? 2 : 1);
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

/** Why an engine gave nothing, for the error the model reads. */
function why(status: number, parsed: number): string {
  if (status === 200) return parsed > 0 ? "nothing about it" : "no results";
  if (status === 401) return "HTTP 401 (its key was refused)";
  if (status === 429) return "HTTP 429 (too many searches for now)";
  if (status === 432) return "HTTP 432 (out of quota for now)";
  return `HTTP ${status}`;
}

/** The first engine that answers with results worth reading wins. When every engine rests, all are
 *  tried anyway. Without a list, the engines set up now (environment, ~/.kinoko/web.json). */
export async function search(query: Query, signal: AbortSignal, list?: Engine[], now = Date.now): Promise<string> {
  const chain = list ?? engines(process.env, await readConfig());
  const awake = chain.filter((e) => (resting.get(e.name) ?? 0) <= now());
  const telling = words(query.q);
  const failures: string[] = [];
  for (const engine of awake.length > 0 ? awake : chain) {
    try {
      const { url, method, body: payload, headers } = engine.request(query);
      // oxlint-disable-next-line no-await-in-loop -- engines are a fallback chain, one at a time by design
      const res = await fetch(url, {
        method: method ?? "GET",
        ...(payload === undefined ? {} : { body: payload }),
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8", ...headers },
        signal: AbortSignal.any([signal, AbortSignal.timeout(ENGINE_MS)]),
      });
      // oxlint-disable-next-line no-await-in-loop -- same chain: the body of the engine just asked
      const body = await res.text();
      const all = res.status === 200 ? dedupe(engine.parse(body, query)) : [];
      const hits = (engine.scraped ? all.filter((h) => relevant(h, telling)) : all).slice(0, query.max);
      if (hits.length > 0) {
        resting.delete(engine.name);
        return format(hits, engine.name);
      }
      if (REFUSED.has(res.status)) resting.set(engine.name, now() + REST_MS);
      failures.push(`${engine.name}: ${why(res.status, all.length)}`);
    } catch (e) {
      if (signal.aborted) throw e;
      failures.push(`${engine.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Only the engines that need nothing, and they all failed: say what would fix it for good.
  const setUp = chain.some((e) => !e.scraped) ? "" : " Searching without a key is often turned away: tell the user a free Tavily key (or their own SearXNG) in ~/.kinoko/web.json makes web search reliable.";
  return `ERROR: web_search found nothing (${failures.join("; ")}). Try other words, or web_fetch a known URL.${setUp}`;
}

/** Forgets which engines rest (tests). */
export function wake(): void {
  resting.clear();
}
