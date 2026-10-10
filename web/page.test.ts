import { afterAll, describe, expect, test } from "bun:test";
import { fetchPage, rewrite } from "./page.ts";

const signal = new AbortController().signal;
const html = (body: string | Uint8Array, type = "text/html; charset=utf-8"): Response => new Response(body, { headers: { "content-type": type } });

// A local web for web_fetch. No real network.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/page") {
      return html(`<html><head><title>A &amp; B</title><style>x{}</style></head><body><nav>menu</nav>
        <main><h1>Hello</h1><p>One&nbsp;two <b>three</b> <a href="/next">next page</a> ${"filler ".repeat(40)}</p>
        <ul><li>first</li><li>second</li></ul><script>alert(1)</script></main><footer>legal</footer></body></html>`);
    }
    if (path === "/latin1") return html(new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]), "text/html; charset=iso-8859-1");
    if (path === "/meta") return html(new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>'), 0x93, 0x68, 0x69, 0x94]), "text/html");
    if (path === "/spa") return html('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
    if (path === "/long") return html("x".repeat(30_000), "text/plain");
    if (path === "/json") return Response.json({ ok: true });
    if (path === "/image") return html("\u0001\u0002", "image/png");
    if (path === "/away") return new Response("no", { status: 403 });
    return new Response("missing", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

describe("web_fetch", () => {
  test("a page as text: title, main content, absolute links, no chrome", async () => {
    const out = await fetchPage(`${base}/page`, 0, signal);
    expect(out).toStartWith(`URL: ${base}/page\nTitle: A & B\n\n# Hello\n\nOne two three [next page](${base}/next) filler`);
    expect(out).toContain("- first\n- second");
    for (const gone of ["menu", "legal", "alert", "x{}"]) expect(out).not.toContain(gone);
  });

  test("the charset from the header, else from the page's <meta>", async () => {
    expect(await fetchPage(`${base}/latin1`, 0, signal)).toEndWith("café");
    expect(await fetchPage(`${base}/meta`, 0, signal)).toEndWith("“hi”");
  });

  test("a page built by JavaScript says so instead of coming back blank", async () => {
    expect(await fetchPage(`${base}/spa`, 0, signal)).toContain("builds its content with JavaScript");
  });

  test("long text comes in pages with the offset to continue from", async () => {
    expect(await fetchPage(`${base}/long`, 0, signal)).toContain("[chars 0-12000 of 30000; continue with offset=12000]");
    expect(await fetchPage(`${base}/long`, 24_000, signal)).not.toContain("continue with offset");
    expect(await fetchPage(`${base}/long`, 40_000, signal)).toContain("[the text ends at 30000 chars]");
  });

  test("JSON as it is; binaries, HTTP errors and non-http URLs are tool errors", async () => {
    expect(await fetchPage(`${base}/json`, 0, signal)).toContain('{"ok":true}');
    expect(await fetchPage(`${base}/image`, 0, signal)).toBe(`ERROR: web_fetch: ${base}/image is image/png, not text`);
    expect(await fetchPage(`${base}/nope`, 0, signal)).toContain("HTTP 404");
    expect(await fetchPage(`${base}/away`, 0, signal)).toContain("turns away scripts");
    expect(await fetchPage("file:///etc/passwd", 0, signal)).toStartWith("ERROR:");
  });

  test("GitHub file pages become the raw file", () => {
    expect(rewrite("https://github.com/oven-sh/bun/blob/main/README.md#install")).toBe("https://raw.githubusercontent.com/oven-sh/bun/main/README.md");
    expect(rewrite("https://github.com/oven-sh/bun")).toBe("https://github.com/oven-sh/bun");
  });

  test("an aborted signal stops a fetch", async () => {
    const cut = new AbortController();
    cut.abort();
    await expect(fetchPage(`${base}/page`, 0, cut.signal)).rejects.toThrow();
  });
});
