// Web: lets the agent look things up. Two read-only tools, no dependency, no key needed.
//   web_search  asks search engines in turn until one answers (search.ts, engines.ts): Tavily, Exa or
//               your SearXNG first when set up (free), then Brave's, DuckDuckGo's and Bing's pages,
//               Wikipedia last.
//   /searxng    sets up your own SearXNG in Docker, the search that is never turned away (searxng.ts).
//   web_fetch   downloads one page and turns it into readable text, paged like `read` (page.ts).

import type { Kinoko, ToolContext } from "../api.ts";
import { PAGE_CHARS, fetchPage } from "./page.ts";
import { searxng } from "./searxng.ts";
import { search } from "./search.ts";

export { decodeEntities, htmlToText } from "./html.ts";
export { fetchPage, rewrite } from "./page.ts";
export { engines, readConfig } from "./engines.ts";
export type { Engine, Query, WebConfig } from "./engines.ts";
export { parseBing, parseBraveApi, parseBravePage, parseDuckDuckGo, parseExa, parseSearxng, parseTavily, parseWikipedia } from "./parsers.ts";
export type { Hit } from "./parsers.ts";
export { relevant, search, wake, words } from "./search.ts";

const MAX_RESULTS = 8;

function count(raw: unknown, fallback: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(0, Math.trunc(raw))) : fallback;
}

export default function (k: Kinoko): void {
  k.registerCommand("searxng", (args) => searxng(args), "Your own SearXNG for web_search: status, setup, use <url>, remove");

  k.registerTool({
    name: "web_search",
    description: "Search the web. Returns numbered results: title, URL, snippet. Read one with web_fetch.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "what to search for; site:example.com narrows to one site" },
        max: { type: "number", description: `results to return (default ${MAX_RESULTS}, at most 20)` },
        region: { type: "string", description: 'market for local results, like "es-ES" (default en-US)' },
      },
      required: ["query"],
    },
    readOnly: true,
    run: async (args: { query?: unknown; max?: unknown; region?: unknown }, ctx: ToolContext) => {
      if (typeof args.query !== "string" || args.query.trim() === "") return "ERROR: web_search: missing query (string)";
      const region = typeof args.region === "string" && /^[a-z]{2}(-[a-z]{2})?$/i.test(args.region.trim()) ? args.region.trim() : undefined;
      return search({ q: args.query.trim(), max: Math.max(1, count(args.max, MAX_RESULTS, 20)), region }, ctx.signal);
    },
  });

  k.registerTool({
    name: "web_fetch",
    description: `Fetch a web page as readable text (HTML as markdown with links and code blocks; JSON and plain text as-is; GitHub file pages as the raw file). Long pages come ${PAGE_CHARS} chars at a time: pass offset to continue.`,
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL" },
        offset: { type: "number", description: "character offset to start from (default 0)" },
      },
      required: ["url"],
    },
    readOnly: true,
    run: async (args: { url?: unknown; offset?: unknown }, ctx: ToolContext) => {
      if (typeof args.url !== "string") return "ERROR: web_fetch: missing url (string)";
      return fetchPage(args.url.trim(), count(args.offset, 0, Number.MAX_SAFE_INTEGER), ctx.signal);
    },
  });
}
