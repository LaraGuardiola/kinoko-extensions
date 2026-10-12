// Notifications: when a run that took a while ends, kinoko says so, on the desktop (Linux notify-send,
// macOS's osascript) and, with a topic set, on the phone through ntfy (https://ntfy.sh). Not when
// you are looking: on Hyprland, a run that ends while kinoko's own window has focus stays quiet.
// The model gets a `notify` tool too, to ping you on purpose ("tell me when the tests pass").
//
//   KINOKO_NOTIFY_AFTER    seconds a run must take before its end is announced (default 30)
//   KINOKO_NTFY            an ntfy topic ("my-kinoko-x7"), or its full URL on your own server
//   KINOKO_NOTIFY_DESKTOP  0 to keep the desktop out of it

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Kinoko, Message, ToolContext } from "../api.ts";

type Env = Record<string, string | undefined>;
const TIMEOUT_MS = 10_000;

export interface Channels {
  desktop: (title: string, body: string) => Promise<void>;
  ntfy: (url: string, title: string, body: string) => Promise<void>;
  /** Whether the focused window is the terminal kinoko runs in. */
  focused: () => Promise<boolean>;
}

async function spawn(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
}

/** The process's ancestors, from /proc: its own pid first. */
async function ancestors(pid: number): Promise<number[]> {
  const chain = [pid];
  for (let i = 0; i < 40; i++) {
    // oxlint-disable-next-line no-await-in-loop -- one parent leads to the next
    const stat = await readFile(`/proc/${chain.at(-1)}/stat`, "utf8").catch(() => "");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!(ppid > 1)) break;
    chain.push(ppid);
  }
  return chain;
}

export const channels = (env: Env = process.env): Channels => ({
  desktop: async (title, body) => {
    if (process.platform === "darwin") await spawn(["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
    // Linux's notify-send where it is installed; elsewhere (Windows) only ntfy reaches you.
    else if (Bun.which("notify-send") !== null) await spawn(["notify-send", "-a", "kinoko", title, body]);
  },
  ntfy: async (url, title, body) => {
    await fetch(url, { method: "POST", body, headers: { title, tags: "mushroom" }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
  },
  focused: async () => {
    if (!env.HYPRLAND_INSTANCE_SIGNATURE) return false;
    const res = await spawn(["hyprctl", "activewindow", "-j"]);
    const pid = Number((JSON.parse(res.out || "{}") as { pid?: number }).pid);
    return pid > 0 && (await ancestors(process.pid)).includes(pid);
  },
});

/** The ntfy URL for a topic or URL; undefined when none is set. */
export function ntfyUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return /^https?:\/\//.test(value) ? value : `https://ntfy.sh/${encodeURIComponent(value)}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The first lines of the model's last reply, as one line. */
function gist(text: string): string {
  const flat = text.replace(/```[\s\S]*?```/g, "").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length <= 180 ? flat : `${flat.slice(0, 179).trimEnd()}…`;
}

export function install(k: Kinoko, ch: Channels = channels(), env: Env = process.env, now: () => number = Date.now): void {
  const after = Number(env.KINOKO_NOTIFY_AFTER ?? 30) * 1000;
  const ntfy = ntfyUrl(env.KINOKO_NTFY);
  const desktop = env.KINOKO_NOTIFY_DESKTOP !== "0";
  let mode = "tui";
  let project = "";
  let started: number | undefined;
  let last = "";

  const send = async (title: string, body: string): Promise<string[]> => {
    const sent: string[] = [];
    const jobs: Promise<void>[] = [];
    if (desktop) jobs.push(ch.desktop(title, body).then(() => void sent.push("desktop")));
    if (ntfy) jobs.push(ch.ntfy(ntfy, title, body).then(() => void sent.push("ntfy")));
    await Promise.all(jobs);
    return sent;
  };

  k.on("session_start", (info) => {
    mode = info.mode;
    project = basename(info.cwd);
  });
  k.on("before_provider_request", () => {
    started ??= now();
  });
  k.on("turn_end", (message: Message) => {
    if (message.role === "assistant" && message.content.trim() !== "") last = message.content;
  });
  k.on("run_end", (result) => {
    const took = started === undefined ? 0 : now() - started;
    started = undefined;
    const reply = last;
    last = "";
    // You stopped it, so you are there; a quick one needs no ping; rpc has its own client.
    if (result.reason === "aborted" || took < after || mode === "rpc") return;
    const what = result.reason === "done" ? "done" : result.reason === "limit" ? "stopped at a limit" : "stopped by an error";
    const title = `kinoko 🍄 ${project}: ${what} in ${duration(took)}`;
    const body = gist(reply) || (result.detail ?? "nothing to say");
    void (async () => {
      if (await ch.focused().catch(() => false)) return;
      await send(title, body);
    })().catch(() => undefined);
  });

  k.registerTool({
    name: "notify",
    description: "Send the user a notification (desktop, and their phone when ntfy is set up): for news they asked to hear about, or a question that needs them.",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        title: { type: "string", description: "default: kinoko and the project" },
      },
      required: ["message"],
    },
    readOnly: true,
    run: async (args: { message?: unknown; title?: unknown }, _ctx: ToolContext) => {
      if (typeof args.message !== "string" || args.message.trim() === "") return "ERROR: notify: missing message (string)";
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : `kinoko 🍄 ${project}`;
      const sent = await send(title, args.message.trim());
      return sent.length > 0 ? `sent (${sent.join(", ")})` : "ERROR: notify: no channel: the desktop is off (KINOKO_NOTIFY_DESKTOP=0) and KINOKO_NTFY is not set";
    },
  });
}

export default function (k: Kinoko): void {
  install(k);
}
