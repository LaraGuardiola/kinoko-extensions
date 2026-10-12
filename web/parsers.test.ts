import { describe, expect, test } from "bun:test";
import { parseBing, parseBraveApi, parseBravePage, parseDuckDuckGo, parseExa, parseSearxng, parseTavily, parseWikipedia } from "./parsers.ts";

const hit = { title: "Bun", url: "https://bun.com", snippet: "fast" };

describe("web: what each engine answers", () => {
  test("the APIs: Tavily, Exa (its highlights), SearXNG, Brave; junk and non-web links are no hits", () => {
    expect(parseTavily(JSON.stringify({ results: [{ title: "Bun", url: "https://bun.com", content: "fast", score: 0.9 }] }))).toEqual([hit]);
    expect(parseExa(JSON.stringify({ results: [{ title: "Bun", url: "https://bun.com", highlights: ["fast", "small"] }] }))).toEqual([{ ...hit, snippet: "fast … small" }]);
    expect(parseExa(JSON.stringify({ results: [{ url: "https://bun.com" }] }))).toEqual([{ title: "https://bun.com", url: "https://bun.com", snippet: "" }]);
    expect(parseSearxng(JSON.stringify({ results: [{ title: "Bun", url: "https://bun.com", content: "fast" }] }))).toEqual([hit]);
    expect(parseBraveApi(JSON.stringify({ web: { results: [{ title: "<strong>Bun</strong>", url: "https://bun.com", description: "fast" }] } }))).toEqual([hit]);
    expect(parseSearxng("<html>not json</html>")).toEqual([]);
    expect(parseTavily(JSON.stringify({ results: [{ title: "x", url: "javascript:1" }] }))).toEqual([]);
  });

  test("Brave's page: each web result's real link, its title and text", () => {
    const html = `<div class="snippet svelte-x" data-pos="0" data-type="web" data-keynav="true"><div class="result-body"><a href="https://github.com/bjarneo/cliamp" class="l1">
      <div class="site-name-content"><div class="t-secondary">GitHub</div></div>
      <div class="title search-snippet-title line-clamp-1 svelte-y" title="GitHub - bjarneo/cliamp: a terminal player &amp; more">GitHub - bjarneo/cliamp</div></a>
      <div class="generic-snippet"><div class="content desktop-default-regular t-primary"><span class="t-secondary">3 days ago -</span> Terminal <strong>music</strong> player</div></div></div>
      <div class="snippet" data-pos="1" data-type="web"><a href="/settings">no</a></div>`;
    expect(parseBravePage(html)).toEqual([{ title: "GitHub - bjarneo/cliamp: a terminal player & more", url: "https://github.com/bjarneo/cliamp", snippet: "3 days ago - Terminal music player" }]);
  });

  test("Wikipedia: each page's link in its language, the excerpt's markup out", () => {
    const body = JSON.stringify({ pages: [{ key: "Tortilla_de_patatas", title: "Tortilla de patatas", excerpt: 'La <span class="searchmatch">tortilla</span> de patatas' }, { title: "no key" }] });
    expect(parseWikipedia(body, "es")).toEqual([{ title: "Tortilla de patatas", url: "https://es.wikipedia.org/wiki/Tortilla_de_patatas", snippet: "La tortilla de patatas" }]);
    expect(parseWikipedia("nope")).toEqual([]);
  });

  test("Bing's page: the real URL is the base64url in u=a1…", () => {
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
});
