import { describe, expect, test } from "bun:test";
import { Bus } from "../testing/bus.ts";
import { duration, install, ntfyUrl } from "./index.ts";
import type { Channels } from "./index.ts";

function setup(env: Record<string, string> = {}, focused = false): { bus: Bus; sent: string[]; tick: (ms: number) => void } {
  const sent: string[] = [];
  let clock = 0;
  const ch: Channels = {
    desktop: async (title, body) => void sent.push(`desktop|${title}|${body}`),
    ntfy: async (url, title, body) => void sent.push(`ntfy|${url}|${title}|${body}`),
    focused: async () => focused,
  };
  const bus = new Bus();
  install(bus, ch, env, () => clock);
  bus.emit("session_start", { cwd: "/home/me/kinoko", model: "m", mode: "tui" });
  return { bus, sent, tick: (ms) => (clock += ms) };
}

/** One run: a request, `ms` later a reply, then its end. */
async function run(s: ReturnType<typeof setup>, ms: number, reason: "done" | "aborted" | "error" = "done"): Promise<void> {
  s.bus.emit("before_provider_request", { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal });
  s.tick(ms);
  s.bus.emit("turn_end", { id: "a", role: "assistant", content: "All **12** tests pass.\n```\nok\n```" });
  s.bus.emit("run_end", { reason });
  await Bun.sleep(5);
}

describe("notify", () => {
  test("a long run's end: desktop and ntfy, with the project, the time and the reply's gist", async () => {
    const s = setup({ KINOKO_NTFY: "my-topic" });
    await run(s, 95_000);
    expect(s.sent).toEqual(["desktop|kinoko 🍄 kinoko: done in 1m 35s|All 12 tests pass.", "ntfy|https://ntfy.sh/my-topic|kinoko 🍄 kinoko: done in 1m 35s|All 12 tests pass."]);
  });

  test("quiet: a quick run, an aborted one, while kinoko's window has focus", async () => {
    const quick = setup();
    await run(quick, 5_000);
    await run(quick, 90_000, "aborted");
    expect(quick.sent).toEqual([]);
    const watched = setup({}, true);
    await run(watched, 90_000);
    expect(watched.sent).toEqual([]);
  });

  test("the threshold and the desktop are configurable", async () => {
    const s = setup({ KINOKO_NOTIFY_AFTER: "2", KINOKO_NOTIFY_DESKTOP: "0", KINOKO_NTFY: "https://ntfy.me/x" });
    await run(s, 3_000, "error");
    expect(s.sent).toEqual(["ntfy|https://ntfy.me/x|kinoko 🍄 kinoko: stopped by an error in 3s|All 12 tests pass."]);
  });

  test("the notify tool sends on every channel, or says there is none", async () => {
    const s = setup({ KINOKO_NTFY: "t" });
    const tool = s.bus.tools()[0];
    expect(await tool?.run({ message: "tests pass" }, { signal: new AbortController().signal, cwd: "/" })).toBe("sent (desktop, ntfy)");
    const none = setup({ KINOKO_NOTIFY_DESKTOP: "0" });
    expect(await none.bus.tools()[0]?.run({ message: "x" }, { signal: new AbortController().signal, cwd: "/" })).toStartWith("ERROR: notify: no channel");
  });

  test("helpers", () => {
    expect(ntfyUrl(" topic ")).toBe("https://ntfy.sh/topic");
    expect(ntfyUrl("")).toBeUndefined();
    expect(duration(42_000)).toBe("42s");
    expect(duration(3_725_000)).toBe("62m 05s");
  });
});
