// What each engine answers, read into hits: a title, the real URL, a snippet. Junk is no hits.

import { decodeEntities, inline } from "./html.ts";

export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

const isWeb = (url: string): boolean => /^https?:\/\//.test(url);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.filter((v) => typeof v === "string").join(" … ") : "";
}

/** JSON results: an array somewhere in the body, each with a URL, a title and a snippet field. */
function jsonHits(body: string, list: (data: Record<string, unknown>) => unknown, snippet: string): Hit[] {
  try {
    const items = list(record(JSON.parse(body)));
    if (!Array.isArray(items)) return [];
    return items
      .map((raw) => record(raw))
      .map((r) => ({ title: inline(str(r.title)) || str(r.url), url: str(r.url), snippet: inline(str(r[snippet])) }))
      .filter((h) => isWeb(h.url));
  } catch {
    return [];
  }
}

/** Tavily: {results: [{title, url, content}]}, made for agents. */
export const parseTavily = (body: string): Hit[] => jsonHits(body, (d) => d.results, "content");
/** Exa: {results: [{title, url, highlights: [...]}]}; a missing title becomes the URL. */
export const parseExa = (body: string): Hit[] => jsonHits(body, (d) => d.results, "highlights");
/** SearXNG's JSON format: {results: [{title, url, content}]}. */
export const parseSearxng = (body: string): Hit[] => jsonHits(body, (d) => d.results, "content");
/** Brave's API: {web: {results: [{title, url, description}]}}. */
export const parseBraveApi = (body: string): Hit[] => jsonHits(body, (d) => record(d.web).results, "description");

/** Wikipedia's search: {pages: [{key, title, excerpt}]}, the excerpt with its matches marked up. */
export function parseWikipedia(body: string, lang = "en"): Hit[] {
  try {
    const pages = record(JSON.parse(body)).pages;
    if (!Array.isArray(pages)) return [];
    return pages
      .map((raw) => record(raw))
      .filter((r) => typeof r.key === "string" && r.key !== "")
      .map((r) => ({ title: inline(str(r.title)), url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(str(r.key))}`, snippet: inline(str(r.excerpt)) }));
  } catch {
    return [];
  }
}

/** Brave's results page: a block per result (data-type="web"), its first link the real URL. */
export function parseBravePage(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split('data-type="web"').slice(1)) {
    const url = decodeEntities(/<a href="(https?:\/\/[^"]+)"/.exec(block)?.[1] ?? "");
    const title = /class="title search-snippet-title[^"]*"[^>]*title="([^"]*)"/.exec(block)?.[1] ?? /class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    const snippet = /class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    if (isWeb(url)) hits.push({ title: inline(title) || url, url, snippet: inline(snippet) });
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
    if (isWeb(url)) hits.push({ title: inline(link[2] ?? ""), url, snippet: inline(snippet) });
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
    if (isWeb(url)) hits.push({ title: inline(link[2] ?? ""), url, snippet: inline(snippet) });
  }
  return hits;
}
