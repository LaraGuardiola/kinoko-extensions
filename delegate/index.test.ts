import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../testing/bus.ts";
import { KNOWN, argv, install, shellQuote } from "./index.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-ext-delegate-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, ".kinoko"), { recursive: true });
// A harness of our own: it answers with the task it got (and the model, when asked for one).
writeFileSync(join(home, ".kinoko", "delegate.json"), JSON.stringify({ harnesses: { echo: { command: ["sh", "-c", 'echo "did: $1"', "x", "{task}"], about: "an echo" } } }));

async function tool(installed: string[]): Promise<(args: Record<string, unknown>, background?: (c: string) => { id: number; pid: number; log: string }) => Promise<string>> {
  const bus = new Bus();
  await install(bus, { home, which: (bin) => (installed.includes(bin) ? `/bin/${bin}` : null) });
  const t = bus.tools().find((x) => x.name === "delegate");
  if (!t) throw new Error("no delegate tool");
  return async (args, background) => {
    const out = await t.run(args, { signal: new AbortController().signal, cwd: home, ...(background ? { background } : {}) });
    return typeof out === "string" ? out : out.text;
  };
}

describe("delegate", () => {
  test("only the installed agents are offered, each with what it is", async () => {
    const bus = new Bus();
    await install(bus, { home, which: (bin) => (bin === "pi" || bin === "sh" ? "/bin/x" : null) });
    const t = bus.tools()[0]!;
    expect((t.schema as { properties: { to: { enum: string[] } } }).properties.to.enum).toEqual(["pi", "echo"]);
    expect(t.description).toContain("pi: pi");
    const none = new Bus();
    await install(none, { home: "/nonexistent", which: () => null });
    expect(none.tools()).toEqual([]);
  });

  test("with no background jobs (print mode) it waits and returns the answer; a bad target or no task says so", async () => {
    const run = await tool(["sh"]);
    expect(await run({ to: "echo", task: "fix the 'bug'" })).toBe("did: fix the 'bug'");
    expect(await run({ to: "opencode", task: "x" })).toBe("ERROR: delegate: to must be one of echo");
    expect(await run({ to: "echo", task: " " })).toBe("ERROR: delegate: missing task (string)");
  });

  test("by default a background job: one shell command, quoted, and a reply that says not to wait", async () => {
    const run = await tool(["sh"]);
    const started: string[] = [];
    const out = await run({ to: "echo", task: "it's done; rm -rf /" }, (c) => (started.push(c), { id: 3, pid: 9, log: "/l/3.log" }));
    expect(started).toEqual([`sh -c 'echo "did: $1"' x 'it'\\''s done; rm -rf /'`]);
    expect(out).toStartWith("echo is working on it as background job #3");
    expect(out).toContain("Do not wait or poll");
    // The quoting holds: the shell gets the task as one argument, as it was.
    const proc = Bun.spawn(["sh", "-c", started[0]!], { stdout: "pipe" });
    expect((await new Response(proc.stdout).text()).trim()).toBe("did: it's done; rm -rf /");
  });

  test("each known agent's command line, with a model when asked for", () => {
    expect(argv(KNOWN.opencode!, "task", "llama.cpp/qwen")).toEqual(["opencode", "run", "-m", "llama.cpp/qwen", "task"]);
    expect(argv(KNOWN.claude!, "task")).toEqual(["claude", "-p", "--permission-mode", "acceptEdits", "task"]);
    expect(argv(KNOWN.codex!, "task", "o3")).toEqual(["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "-m", "o3", "task"]);
    expect(argv(KNOWN.kinoko!, "task", "m")).toEqual(["kinoko", "--mode", "print", "--model", "m", "task"]);
    expect(shellQuote("plain-arg")).toBe("plain-arg");
  });
});
