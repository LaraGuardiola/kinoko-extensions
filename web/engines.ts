// web_search's engines, in the order they are tried. First the ones you set up: Tavily and Exa (an
// API key from their sites) and your own SearXNG (/searxng: no account, no limit); a Brave API key
// still works. Then the ones that need nothing: Brave's results page, DuckDuckGo's, Bing's, and
// Wikipedia's search last. Without a key they turn kinoko away after a few searches in a row.
// Keys come from the environment or ~/.kinoko/web.json, read on every search: no restart.

import { join } from "node:path";
import type { Hit } from "./parsers.ts";
import { parseBing, parseBraveApi, parseBravePage, parseDuckDuckGo, parseExa, parseSearxng, parseTavily, parseWikipedia } from "./parsers.ts";

export interface Query {
  q: string;
  max: number;
  /** A market like "es-ES"; engines that know regions use it. */
  region?: string;
}

export interface Engine {
  name: string;
  request: (query: Query) => { url: string; method?: "POST"; body?: string; headers?: Record<string, string> };
  parse: (body: string, query: Query) => Hit[];
  /** A scraped page, not an API: its hits must share words with the query (relevant.ts). */
  scraped?: boolean;
}

/** What ~/.kinoko/web.json may hold; the environment's TAVILY_API_KEY, EXA_API_KEY, SEARXNG_URL and
 *  BRAVE_API_KEY win over it. */
export interface WebConfig {
  tavily?: string;
  exa?: string;
  searxng?: string;
  brave?: string;
}

/** ~/.kinoko/web.json, or nothing when there is none (or it is not JSON). */
export async function readConfig(home = process.env.HOME ?? ""): Promise<WebConfig> {
  try {
    const data = (await Bun.file(join(home, ".kinoko", "web.json")).json()) as Record<string, unknown>;
    const text = (key: string): string | undefined => (typeof data[key] === "string" && data[key] !== "" ? (data[key] as string) : undefined);
    return { tavily: text("tavily"), exa: text("exa"), searxng: text("searxng"), brave: text("brave") };
  } catch {
    return {};
  }
}

const enc = encodeURIComponent;
const json = { "content-type": "application/json", accept: "application/json" };
/** Bing's market. Without one Bing follows the IP's country: English queries came back half in Spanish. */
const mkt = (region?: string): string => enc(region ?? "en-US");
/** The region's language, for Wikipedia: "es-ES" → es. */
const lang = (region?: string): string => (region?.split("-")[0] ?? "en").toLowerCase();

export function engines(env: Record<string, string | undefined> = process.env, file: WebConfig = {}): Engine[] {
  const tavily = env.TAVILY_API_KEY || file.tavily;
  const exa = env.EXA_API_KEY || file.exa;
  const searx = (env.SEARXNG_URL || file.searxng)?.replace(/\/+$/, "");
  const brave = env.BRAVE_API_KEY || file.brave;
  const list: Engine[] = [];
  if (tavily) {
    list.push({
      name: "tavily",
      request: ({ q, max, region }) => ({
        url: "https://api.tavily.com/search",
        method: "POST",
        body: JSON.stringify({ query: q, max_results: Math.min(max, 20), search_depth: "basic", ...(region ? { language: region.split("-")[0] } : {}) }),
        headers: { ...json, authorization: `Bearer ${tavily}` },
      }),
      parse: parseTavily,
    });
  }
  if (exa) {
    list.push({
      name: "exa",
      request: ({ q, max }) => ({
        url: "https://api.exa.ai/search",
        method: "POST",
        body: JSON.stringify({ query: q, numResults: Math.min(max, 20), type: "auto", contents: { highlights: { maxCharacters: 300 } } }),
        headers: { ...json, "x-api-key": exa },
      }),
      parse: parseExa,
    });
  }
  if (searx) {
    list.push({
      name: "searxng",
      request: ({ q, region }) => ({ url: `${searx}/search?format=json&q=${enc(q)}${region ? `&language=${enc(region)}` : ""}` }),
      parse: parseSearxng,
    });
  }
  if (brave) {
    list.push({
      name: "brave-api",
      request: ({ q, max, region }) => ({
        url: `https://api.search.brave.com/res/v1/web/search?q=${enc(q)}&count=${Math.min(max, 20)}${region?.includes("-") ? `&country=${enc(region.split("-")[1] ?? "")}` : ""}`,
        headers: { accept: "application/json", "x-subscription-token": brave },
      }),
      parse: parseBraveApi,
    });
  }
  list.push(
    { name: "brave", request: ({ q }) => ({ url: `https://search.brave.com/search?q=${enc(q)}&source=web` }), parse: parseBravePage, scraped: true },
    { name: "duckduckgo", request: ({ q }) => ({ url: `https://html.duckduckgo.com/html/?q=${enc(q)}` }), parse: parseDuckDuckGo, scraped: true },
    { name: "bing", request: ({ q, region }) => ({ url: `https://www.bing.com/search?q=${enc(q)}&mkt=${mkt(region)}` }), parse: parseBing, scraped: true },
    // Last: never turns anyone away, and knows the facts (in the region's language).
    { name: "wikipedia", request: ({ q, max, region }) => ({ url: `https://${lang(region)}.wikipedia.org/w/rest.php/v1/search/page?q=${enc(q)}&limit=${Math.min(max, 10)}` }), parse: (body, { region }) => parseWikipedia(body, lang(region)), scraped: true },
  );
  return list;
}
