import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../testing/bus.ts";
import { install } from "./index.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-ext-telegram-"));
const TOKEN = "123:secret-token";
const got: Array<{ path: string; chat: string; caption: string | null; name: string; text: string }> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(`/bot${TOKEN}/`)) return Response.json({ ok: false, description: `Unauthorized for ${path}` }, { status: 401 });
    const form = await req.formData();
    const doc = form.get("document") as File;
    got.push({ path, chat: String(form.get("chat_id")), caption: form.get("caption") as string | null, name: doc.name, text: await doc.text() });
    return Response.json({ ok: true, result: {} });
  },
});
afterAll(() => {
  void server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

function tool(): (args: Record<string, unknown>) => Promise<string> {
  const bus = new Bus();
  install(bus, { home, apiBase: `http://127.0.0.1:${server.port}` });
  const t = bus.tools().find((x) => x.name === "telegram_send")!;
  return async (args) => {
    const out = await t.run(args, { signal: new AbortController().signal, cwd: home });
    return typeof out === "string" ? out : out.text;
  };
}

const pair = (token = TOKEN): void => {
  mkdirSync(join(home, ".kinoko"), { recursive: true });
  writeFileSync(join(home, ".kinoko", "integrations.json"), JSON.stringify({ telegram: { token, bot: "b", chat: 42 } }));
};

describe("telegram", () => {
  test("not paired yet: says how; a missing file and a folder are refused", async () => {
    const send = tool();
    writeFileSync(join(home, "a.txt"), "hi");
    expect(await send({ path: "a.txt" })).toContain("not set up");
    pair();
    expect(await send({ path: "nope.txt" })).toStartWith("ERROR: telegram_send: no file");
    expect(await send({ path: ".kinoko" })).toContain("is a folder");
  });

  test("sends the file as a document to the paired chat, with its name and caption", async () => {
    pair();
    writeFileSync(join(home, "report.md"), "# done");
    expect(await tool()({ path: "report.md", caption: "here it is" })).toBe("sent report.md (6 B) to Telegram");
    expect(got.at(-1)).toEqual({ path: `/bot${TOKEN}/sendDocument`, chat: "42", caption: "here it is", name: "report.md", text: "# done" });
  });

  test("a refusal is said without the token", async () => {
    pair("999:other-secret");
    const out = await tool()({ path: join(home, "report.md") });
    expect(out).toStartWith("ERROR: telegram_send: Telegram refused it");
    expect(out).not.toContain("other-secret");
  });
});
