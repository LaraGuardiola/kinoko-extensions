import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Engine } from "./engines.ts";
import { parseSearxng } from "./parsers.ts";
import { relevant, search, wake, words } from "./search.ts";

const signal = new AbortController().signal;
let asked: string[] = [];

const results = (hits: Array<[string, string, string]>): Response => Response.json({ results: hits.map(([title, url, content]) => ({ title, url, content })) });

// Engines on localhost: one that turns scripts away, one empty, one off topic, one with results.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    asked.push(path);
    if (path === "/blocked") return new Response("bot check", { status: 202 });
    if (path === "/quota") return new Response("plan limit", { status: 432 });
    if (path === "/empty") return results([]);
    if (path === "/slow") return Bun.sleep(5_000).then(() => new Response(""));
    if (path === "/offtopic") return results([["The Big List", "https://junk.example/", "anything at all"]]);
    return results([
      ["Bun runtime docs", "https://example.com/a", "About the Bun runtime"],
      ["Again", "https://www.example.com/a/", "dup"],
      ["Bun release notes", "https://example.com/b", ""],
    ]);
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(() => {
  wake();
  asked = [];
});

const local = (name: string, path: string, scraped = false): Engine => ({ name, request: () => ({ url: `${base}${path}` }), parse: parseSearxng, scraped });

const hit = (title: string, snippet = ""): { title: string; url: string; snippet: string } => ({ title, url: "https://x.example/", snippet });

describe("web: is a hit about the query", () => {
  test("the telling words: no short or common ones, no operators, accents folded", () => {
    expect(words("Who won the 2022 World Cup?")).toEqual(["won", "2022", "world", "cup"]);
    expect(words("receta de la tortilla de patatas site:recetas.com")).toEqual(["receta", "tortilla", "patatas"]);
    expect(words("Café")).toEqual(["cafe"]);
  });

  test("one word for a short query, two for a longer one; no telling words, anything goes", () => {
    expect(relevant(hit("The Big List of Porn"), words("who won the 2022 world cup"))).toBe(false);
    expect(relevant(hit("World Cup 2022 final", "Argentina won"), words("who won the 2022 world cup"))).toBe(true);
    expect(relevant(hit("Mundial", "solo una: world"), words("who won the 2022 world cup"))).toBe(false);
    expect(relevant(hit("cliamp"), words("cliamp"))).toBe(true);
    expect(relevant(hit("anything"), words("a b"))).toBe(true);
  });
});

describe("web: the engine chain", () => {
  test("falls through a bot check, an empty answer and an off-topic page; the same page twice shows once", async () => {
    const chain = [local("first", "/blocked"), local("second", "/empty"), local("third", "/offtopic", true), local("fourth", "/results")];
    const out = await search({ q: "bun runtime", max: 5 }, signal, chain);
    expect(out).toBe("1. Bun runtime docs\n   https://example.com/a\n   About the Bun runtime\n2. Bun release notes\n   https://example.com/b\n\n(via fourth; read a result with web_fetch)");
  });

  test("an API's hits are taken as they are: only scraped pages are checked", async () => {
    expect(await search({ q: "bun runtime", max: 1 }, signal, [local("api", "/offtopic")])).toContain("The Big List");
  });

  test("an engine that turned kinoko away rests, a spent quota too; when all rest, all are tried", async () => {
    let clock = 0;
    const now = (): number => clock;
    const chain = [local("first", "/blocked"), local("quota", "/quota"), local("second", "/results")];
    await search({ q: "bun", max: 1 }, signal, chain, now);
    await search({ q: "bun", max: 1 }, signal, chain, now);
    expect(asked).toEqual(["/blocked", "/quota", "/results", "/results"]);
    clock = 11 * 60_000; // rested enough
    asked = [];
    await search({ q: "bun", max: 1 }, signal, chain, now);
    expect(asked).toEqual(["/blocked", "/quota", "/results"]);
    wake();
    const none = await search({ q: "bun", max: 1 }, signal, [local("first", "/blocked"), local("quota", "/quota"), local("off", "/offtopic", true)], now);
    expect(none).toBe("ERROR: web_search found nothing (first: HTTP 202; quota: HTTP 432 (out of quota for now); off: nothing about it). Try other words, or web_fetch a known URL.");
  });

  test("all failed with nothing set up: the error says what makes it reliable", async () => {
    expect(await search({ q: "bun", max: 1 }, signal, [local("page", "/empty", true)])).toEndWith("tell the user a free Tavily key (or their own SearXNG) in ~/.kinoko/web.json makes web search reliable.");
    expect(await search({ q: "bun", max: 1 }, signal, [local("api", "/empty")])).not.toContain("Tavily");
  });

  test("Esc cuts a slow engine at once: the abort reaches the caller", async () => {
    const cut = new AbortController();
    const run = search({ q: "x", max: 1 }, cut.signal, [local("slow", "/slow"), local("next", "/results")]);
    setTimeout(() => cut.abort(), 20);
    await expect(run).rejects.toThrow();
  });
});
