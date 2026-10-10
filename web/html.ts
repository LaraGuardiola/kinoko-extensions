// HTML as text a model can read: the page's main content as light markdown (headings, lists,
// links, code blocks with their indentation), the chrome around it gone. Regexes, not a parser:
// good enough for documentation, articles and READMEs, which is what an agent reads.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°",
  times: "×", divide: "÷", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", para: "¶", sect: "§",
  euro: "€", pound: "£", yen: "¥", cent: "¢", iexcl: "¡", iquest: "¿", zwj: "", zwnj: "", shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Tags stripped, entities decoded, whitespace folded: one clean line. Engines also send some
 *  highlighting escaped (&lt;strong&gt;), so those few tags go again after decoding. */
export function inline(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/<\/?(strong|b|em|i|span|mark)>/gi, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Where the content is: <main>, else the longest <article>, else the body. */
function content(html: string): { html: string; whole: boolean } {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1];
  if (main !== undefined && inline(main).length > 200) return { html: main, whole: false };
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1] ?? "");
  const longest = articles.reduce((best, a) => (a.length > best.length ? a : best), "");
  if (inline(longest).length > 200) return { html: longest, whole: false };
  return { html: /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html, whole: true };
}

/** An href made absolute; undefined for anchors, scripts, mail links and nonsense. */
function absolute(href: string, base: string | undefined): string | undefined {
  try {
    const url = new URL(decodeEntities(href), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An HTML page as readable text. `base` (the page's URL) makes its links absolute; without it
 *  links stay as their text. */
export function htmlToText(html: string, base?: string): { title: string; text: string } {
  const title = inline(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template|head|iframe|select|button)\b[\s\S]*?<\/\1>/gi, "");
  const found = content(clean);
  const chrome = found.whole ? "nav|aside|footer|header|form|dialog" : "nav|aside|form|dialog";
  let body = found.html.replace(new RegExp(`<(${chrome})\\b[\\s\\S]*?<\\/\\1>`, "gi"), "");

  // Code blocks keep every space: set aside before whitespace is folded, put back at the end.
  const blocks: string[] = [];
  body = body.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_m, attrs: string, code: string) => {
    const lang = /language-([\w+-]+)/.exec(`${attrs} ${code.slice(0, 200)}`)?.[1] ?? "";
    const raw = decodeEntities(code.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/^\n+|\s+$/g, "");
    blocks.push(`\`\`\`${lang}\n${raw}\n\`\`\``);
    return `\n\n\ue000${blocks.length - 1}\ue000\n\n`;
  });

  body = body
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => {
      const text = inline(code);
      return text ? `\`${text}\`` : "";
    })
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = inline(inner);
      const url = base === undefined ? undefined : absolute(href, base);
      // A heading's own anchor (#, ¶) or a jump within the page says nothing a reader can follow.
      if (url === undefined || text === url || !/[\p{L}\p{N}]/u.test(text) || url.split("#")[0] === base?.split("#")[0]) return text.length > 1 ? text : "";
      return `[${text}](${url})`;
    })
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inline(inner)}\n\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|footer|ul|ol|dl|table|thead|tbody|tr|blockquote|figure|figcaption|details|summary)\b[^>]*>/gi, "\n\n")
    .replace(/<(dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "");

  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/^-\n+(?=[^-\n])/gm, "- ") // a list item whose text sits in its own paragraph
    .replace(/^-$\n?/gm, "") // an empty one
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\ue000(\d+)\ue000/g, (_m, i: string) => blocks[Number(i)] ?? "")
    .trim();
  return { title, text };
}
