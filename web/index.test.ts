import { describe, expect, test } from "bun:test";
import type { Tool } from "../api.ts";
import install from "./index.ts";

function tools(): Tool[] {
  const list: Tool[] = [];
  install({ registerTool: (t: Tool) => list.push(t), on: () => undefined, registerCommand: () => undefined, registerRenderer: () => undefined, log: () => undefined });
  return list;
}

const ctx = { signal: new AbortController().signal, cwd: "/" };

describe("web extension", () => {
  test("installs two read-only tools", () => {
    expect(tools().map((t) => [t.name, t.readOnly])).toEqual([["web_search", true], ["web_fetch", true]]);
  });

  test("bad arguments are tool errors, never a request", async () => {
    const [search, fetch] = tools();
    expect(await search?.run({ query: "  " }, ctx)).toBe("ERROR: web_search: missing query (string)");
    expect(await fetch?.run({}, ctx)).toBe("ERROR: web_fetch: missing url (string)");
    expect(await fetch?.run({ url: "ftp://x" }, ctx)).toBe("ERROR: web_fetch needs an http(s) URL");
  });
});
