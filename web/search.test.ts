import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { engines, parseBing, parseBingRss, parseBraveApi, parseDuckDuckGo, parseMarginalia, parseSearxng, search, wake } from "./search.ts";
import type { Engine } from "./search.ts";

const signal = new AbortController().signal;
let asked: string[] = [];

// Engines on localhost: one that turns scripts away, one empty, one with results. No real network.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    asked.push(path);
    if (path === "/blocked") return new Response("bot check", { status: 202 });
    if (path === "/empty") return new Response("<html>nothing</html>");
    if (path === "/slow") return Bun.sleep(5_000).then(() => new Response(""));
    return new Response(`<item><title>Result A</title><link>https://example.com/a</link><description>About A</description></item>
      <item><title>Again</title><link>https://www.example.com/a/</link><description>dup</description></item>
      <item><title>B</title><link>https://example.com/b</link><description></description></item>`);
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(() => {
  wake();
  asked = [];
});

const local = (name: string, path: string): Engine => ({ name, request: () => ({ url: `${base}${path}` }), parse: parseBingRss });

describe("web: parsers", () => {
  test("Bing RSS: real URLs, escaped highlighting dropped", () => {
    const xml = `<channel><title>Bing</title><item><title>Bun &amp; Docs</title><link>https://bun.com/docs</link>
      <description>Fast &lt;strong&gt;runtime&lt;/strong&gt;</description><pubDate>x</pubDate></item></channel>`;
    expect(parseBingRss(xml)).toEqual([{ title: "Bun & Docs", url: "https://bun.com/docs", snippet: "Fast runtime" }]);
  });

  test("Bing page: the real URL is the base64url in u=a1…", () => {
    const encoded = Buffer.from("https://bun.com/docs").toString("base64url");
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;p=1&amp;u=a1${encoded}&amp;ntb=1">Bun</a></h2>
      <p class="b_lineclamp2">Runtime</p></li>`;
    expect(parseBing(html)).toEqual([{ title: "Bun", url: "https://bun.com/docs", snippet: "Runtime" }]);
  });

  test("DuckDuckGo: the real URL comes out of the uddg redirect; ads are skipped", () => {
    const html = `<div class="result results_links result--ad"><a class="result__a" href="//ad">Ad</a></div>
      <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.com%2Fdocs&amp;rut=1">Bun Docs</a>
      <a class="result__snippet" href="x">The <b>docs</b></a></div>`;
    expect(parseDuckDuckGo(html)).toEqual([{ title: "Bun Docs", url: "https://bun.com/docs", snippet: "The docs" }]);
  });

  test("JSON APIs: SearXNG, Brave, Marginalia (a missing title becomes the URL); junk is no results", () => {
    const hit = { title: "Bun", url: "https://bun.com", snippet: "fast" };
    expect(parseSearxng(JSON.stringify({ results: [{ title: "Bun", url: "https://bun.com", content: "fast" }] }))).toEqual([hit]);
    expect(parseBraveApi(JSON.stringify({ web: { results: [{ title: "<strong>Bun</strong>", url: "https://bun.com", description: "fast" }] } }))).toEqual([hit]);
    expect(parseMarginalia(JSON.stringify({ results: [{ title: "", url: "https://bun.com", description: "fast" }] }))).toEqual([{ ...hit, title: "https://bun.com" }]);
    expect(parseSearxng("<html>not json</html>")).toEqual([]);
    expect(parseBraveApi(JSON.stringify({ web: { results: [{ title: "x", url: "javascript:1" }] } }))).toEqual([]);
  });
});

describe("web: the engine chain", () => {
  test("with no keys: Bing's feed, Bing's page, DuckDuckGo, Marginalia; keys put their engines first", () => {
    expect(engines({}).map((e) => e.name)).toEqual(["bing", "bing-page", "duckduckgo", "marginalia"]);
    const keyed = engines({ SEARXNG_URL: "http://searx.local/", BRAVE_API_KEY: "k" });
    expect(keyed.map((e) => e.name).slice(0, 2)).toEqual(["searxng", "brave"]);
    expect(keyed[0]?.request({ q: "a b", max: 5 }).url).toBe("http://searx.local/search?format=json&q=a%20b");
    expect(keyed[1]?.request({ q: "a", max: 50, region: "es-ES" })).toEqual({
      url: "https://api.search.brave.com/res/v1/web/search?q=a&count=20&country=ES",
      headers: { accept: "application/json", "x-subscription-token": "k" },
    });
    expect(engines({})[0]?.request({ q: "a", max: 5 }).url).toContain("format=rss&q=a&mkt=en-US");
    expect(engines({})[0]?.request({ q: "a", max: 5, region: "es-ES" }).url).toContain("mkt=es-ES");
  });

  test("falls through a bot check and an empty page; the same page twice shows once", async () => {
    const out = await search({ q: "x", max: 5 }, signal, [local("first", "/blocked"), local("second", "/empty"), local("third", "/results")]);
    expect(out).toBe("1. Result A\n   https://example.com/a\n   About A\n2. B\n   https://example.com/b\n\n(via third; read a result with web_fetch)");
  });

  test("an engine that turned kinoko away rests; when all rest, all are tried", async () => {
    let clock = 0;
    const now = (): number => clock;
    const chain = [local("first", "/blocked"), local("second", "/results")];
    await search({ q: "x", max: 1 }, signal, chain, now);
    await search({ q: "x", max: 1 }, signal, chain, now);
    expect(asked).toEqual(["/blocked", "/results", "/results"]);
    clock = 11 * 60_000; // rested enough
    asked = [];
    await search({ q: "x", max: 1 }, signal, chain, now);
    expect(asked).toEqual(["/blocked", "/results"]);
    const none = await search({ q: "x", max: 1 }, signal, [local("first", "/blocked")], now);
    expect(none).toStartWith("ERROR: web_search found nothing (first: HTTP 202)");
  });

  test("Esc cuts a slow engine at once: the abort reaches the caller", async () => {
    const cut = new AbortController();
    const run = search({ q: "x", max: 1 }, cut.signal, [local("slow", "/slow"), local("next", "/results")]);
    setTimeout(() => cut.abort(), 20);
    await expect(run).rejects.toThrow();
  });
});
