import { describe, expect, test } from "bun:test";
import { decodeEntities, htmlToText, inline } from "./html.ts";

describe("web: HTML to text", () => {
  test("entities, named and numeric; unknown ones stay", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#243; &#x41; &mdash; &rsquo;&unknown;")).toBe("a & b <c> ó A — ’&unknown;");
  });

  test("inline: tags out, escaped highlighting out, one line", () => {
    expect(inline("Fast &lt;strong&gt;runtime&lt;/strong&gt;\n  <b>here</b>")).toBe("Fast runtime here");
  });

  test("main content only: headings and list items marked, chrome and scripts gone", () => {
    const html = `<title>T</title><nav>menu</nav><main><h2>Head</h2><p>a&amp;b ${"word ".repeat(50)}</p>
      <ul><li>x</li><li><p>y</p></li><li></li></ul><script>bad()</script></main><footer>legal</footer>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("T");
    expect(text).toStartWith("## Head\n\na&b word");
    expect(text).toEndWith("- x\n- y");
    for (const gone of ["menu", "legal", "bad()"]) expect(text).not.toContain(gone);
  });

  test("without <main>, the longest <article>; without either, the body minus its chrome", () => {
    const long = "long ".repeat(60);
    expect(htmlToText(`<article>short</article><article><p>${long}</p></article>`).text).toBe(long.trim());
    expect(htmlToText("<body><header>logo</header><p>text</p><footer>legal</footer></body>").text).toBe("text");
  });

  test("code blocks keep their indentation and language; inline code gets backticks", () => {
    const html = `<p>Call <code>run()</code>:</p><pre class="language-ts"><code>if (x) {\n    <span>go</span>(&lt;T&gt;);\n}</code></pre>`;
    expect(htmlToText(html).text).toBe("Call `run()`:\n\n```ts\nif (x) {\n    go(<T>);\n}\n```");
  });

  test("links become absolute markdown links; anchors and jumps within the page stay text", () => {
    const html = `<h2>Setup<a href="#setup">#</a></h2><p><a href="/docs/api">the API</a>, <a href="https://x.dev/">https://x.dev/</a>,
      <a href="#top">top</a>, <a href="javascript:void 0">nothing</a></p>`;
    expect(htmlToText(html, "https://bun.com/docs/intro").text).toBe("## Setup\n\n[the API](https://bun.com/docs/api), https://x.dev/,\ntop, nothing");
    expect(htmlToText(html).text).toContain("the API, https://x.dev/");
  });

  test("tables keep their cells apart", () => {
    expect(htmlToText("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>").text).toBe("a | b |\n\n1 | 2 |");
  });
});
