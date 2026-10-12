import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engines, readConfig } from "./engines.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-web-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("web: the engines", () => {
  test("with nothing set up: Brave's, DuckDuckGo's and Bing's pages, all checked against the query", () => {
    expect(engines({}).map((e) => [e.name, e.scraped])).toEqual([["brave", true], ["duckduckgo", true], ["bing", true], ["wikipedia", true]]);
    expect(engines({})[3]?.request({ q: "tortilla", max: 50, region: "es-ES" }).url).toBe("https://es.wikipedia.org/w/rest.php/v1/search/page?q=tortilla&limit=10");
    expect(engines({})[0]?.request({ q: "a b", max: 5 }).url).toBe("https://search.brave.com/search?q=a%20b&source=web");
    expect(engines({})[2]?.request({ q: "a", max: 5, region: "es-ES" }).url).toContain("mkt=es-ES");
  });

  test("set up ones first, in order: Tavily, Exa, SearXNG, Brave's API; the environment over web.json", () => {
    const all = engines({ EXA_API_KEY: "env-exa", SEARXNG_URL: "http://searx.local/" }, { tavily: "tvly-file", exa: "file-exa", brave: "b" });
    expect(all.map((e) => e.name)).toEqual(["tavily", "exa", "searxng", "brave-api", "brave", "duckduckgo", "bing", "wikipedia"]);
    const [tavily, exa, searx, brave] = all;
    const t = tavily?.request({ q: "bun", max: 50, region: "es-ES" });
    expect(t).toMatchObject({ url: "https://api.tavily.com/search", method: "POST", headers: { authorization: "Bearer tvly-file" } });
    expect(JSON.parse(t?.body ?? "")).toEqual({ query: "bun", max_results: 20, search_depth: "basic", language: "es" });
    const e = exa?.request({ q: "bun", max: 5 });
    expect(e?.headers?.["x-api-key"]).toBe("env-exa");
    expect(JSON.parse(e?.body ?? "")).toEqual({ query: "bun", numResults: 5, type: "auto", contents: { highlights: { maxCharacters: 300 } } });
    expect(searx?.request({ q: "a b", max: 5 }).url).toBe("http://searx.local/search?format=json&q=a%20b");
    expect(brave?.request({ q: "a", max: 50, region: "es-ES" })).toEqual({
      url: "https://api.search.brave.com/res/v1/web/search?q=a&count=20&country=ES",
      headers: { accept: "application/json", "x-subscription-token": "b" },
    });
    expect(all.filter((x) => !x.scraped).length).toBe(4);
  });

  test("~/.kinoko/web.json: its keys; none, empty or broken is nothing set up", async () => {
    expect(await readConfig(home)).toEqual({});
    mkdirSync(join(home, ".kinoko"), { recursive: true });
    writeFileSync(join(home, ".kinoko", "web.json"), JSON.stringify({ tavily: "tvly-1", exa: "", searxng: "http://localhost:8888", other: 1 }));
    expect(await readConfig(home)).toEqual({ tavily: "tvly-1", exa: undefined, searxng: "http://localhost:8888", brave: undefined });
    writeFileSync(join(home, ".kinoko", "web.json"), "{ not json");
    expect(await readConfig(home)).toEqual({});
  });
});
