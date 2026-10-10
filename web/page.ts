// web_fetch: one page as readable text, paged like `read`. HTML becomes light markdown (html.ts);
// text, JSON and code come as they are, in the charset the server says; anything else is refused.

import { htmlToText } from "./html.ts";
import { TIMEOUT_MS, UA } from "./search.ts";

/** ~3k tokens per page of a fetched document. */
export const PAGE_CHARS = 12_000;
/** More than any page worth reading: a big download stops here instead of filling memory. */
const MAX_BYTES = 5_000_000;

/** A GitHub file page is mostly chrome around the file: the raw file is what the model wants. */
export function rewrite(url: string): string {
  const blob = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url);
  return blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]?.replace(/[?#].*$/, "")}` : url;
}

/** The body, at most MAX_BYTES of it, decoded in its charset: the header's, else the page's
 *  <meta>, else UTF-8. */
async function body(res: Response): Promise<{ text: string; cut: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk after chunk
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_BYTES) {
        cut = true;
        break;
      }
    }
    if (cut) await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const charset =
    /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
  try {
    // Any label the server sends: TextDecoder throws on the ones it does not know.
    return { text: new TextDecoder(charset.toLowerCase() as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes), cut };
  } catch {
    return { text: new TextDecoder().decode(bytes), cut };
  }
}

/** One page of a document, with the offset to continue from when more follows. */
function page(text: string, offset: number): string {
  const end = Math.min(text.length, offset + PAGE_CHARS);
  if (offset >= text.length && text.length > 0) return `[the text ends at ${text.length} chars]`;
  const more = end < text.length ? `\n\n[chars ${offset}-${end} of ${text.length}; continue with offset=${end}]` : "";
  return text.slice(offset, end) + more;
}

export async function fetchPage(input: string, offset: number, signal: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(input)) return "ERROR: web_fetch needs an http(s) URL";
  const url = rewrite(input);
  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    redirect: "follow",
  });
  if (!res.ok) {
    await res.body?.cancel();
    return `ERROR: web_fetch: HTTP ${res.status} for ${url}${res.status === 403 || res.status === 429 ? " (the site turns away scripts; try another source)" : ""}`;
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const textual = type === "" || /html|xml|^text\/|json|javascript|ecmascript|yaml|toml|csv|markdown/.test(type);
  if (!textual) {
    await res.body?.cancel();
    return `ERROR: web_fetch: ${url} is ${type.split(";")[0]}, not text`;
  }
  const final = res.url || url;
  const { text: raw, cut } = await body(res);
  const tail = cut ? `\n[only the first ${MAX_BYTES / 1_000_000} MB was downloaded]` : "";
  const html = /html|xhtml/.test(type) || (type === "" && /^\s*(<!doctype html|<html)/i.test(raw));
  if (!html) return `URL: ${final}\n\n${page(raw, offset)}${tail}`;
  const { title, text } = htmlToText(raw, final);
  // A page that builds itself in the browser sends little but scripts.
  const empty = text.length < 200 && /<script\b/i.test(raw) ? "\n[little text came through: this page builds its content with JavaScript]" : "";
  return `URL: ${final}\n${title ? `Title: ${title}\n` : ""}\n${page(text, offset)}${tail}${empty}`;
}
