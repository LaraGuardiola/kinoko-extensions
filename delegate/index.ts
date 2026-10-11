// delegate: hands a task to another coding agent (opencode, pi, Claude Code, Codex, another kinoko)
// run non-interactively in the project. By default as a background job: the other agent works
// on its own (its output live in the TUI's ⚙ shells window), and kinoko is woken with its answer
// when it ends. Where there are no background jobs (print mode) it waits for the answer instead.
// No `wait` for the model to choose: the Qwen picked it even when told "in the background",
// and being woken already covers "when it is done, do this".
//
// The harnesses offered are the ones installed. ~/.kinoko/delegate.json adds or changes them:
//   { "harnesses": { "aider": { "command": ["aider", "--yes", "--message", "{task}"],
//                               "model": ["--model", "{model}"], "about": "Aider" } } }

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Kinoko, ToolContext } from "../api.ts";

export interface Harness {
  /** argv; "{task}" is replaced by the task. */
  command: string[];
  /** Inserted before the task when a model is asked for; "{model}" is replaced. */
  model?: string[];
  about: string;
}

/** How each known agent runs without its UI. Edits stay in the project; shells are each one's own business. */
export const KNOWN: Record<string, Harness> = {
  opencode: { command: ["opencode", "run", "{task}"], model: ["-m", "{model}"], about: "opencode (its own permissions)" },
  pi: { command: ["pi", "-p", "{task}"], model: ["--model", "{model}"], about: "pi" },
  claude: { command: ["claude", "-p", "--permission-mode", "acceptEdits", "{task}"], model: ["--model", "{model}"], about: "Claude Code (edits allowed, no shell commands)" },
  codex: { command: ["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", "{task}"], model: ["-m", "{model}"], about: "Codex (the project's sandbox)" },
  kinoko: { command: ["kinoko", "--mode", "print", "{task}"], model: ["--model", "{model}"], about: "another kinoko (fresh context)" },
};

/** Waits at most this long in the foreground (print mode). */
const WAIT_MS = 30 * 60_000;
const MAX_OUTPUT = 24_000;

export interface Options {
  home?: string;
  /** Whether a program is installed (tests pass a fake). */
  which?: (bin: string) => string | null;
}

/** The argv for a task: the task in place of {task}, the model's flags right before it. */
export function argv(h: Harness, task: string, model?: string): string[] {
  const out: string[] = [];
  for (const part of h.command) {
    if (part === "{task}") {
      if (model && h.model) out.push(...h.model.map((m) => m.replace("{model}", model)));
      out.push(task);
    } else out.push(part);
  }
  return out;
}

/** One argument for sh: single-quoted, its own quotes escaped. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

async function harnesses(home: string, which: (bin: string) => string | null): Promise<Record<string, Harness>> {
  const all: Record<string, Harness> = { ...KNOWN };
  try {
    const extra = (await Bun.file(join(home, ".kinoko", "delegate.json")).json()) as { harnesses?: Record<string, Partial<Harness>> };
    for (const [name, h] of Object.entries(extra.harnesses ?? {})) {
      if (Array.isArray(h.command) && h.command.every((p) => typeof p === "string")) all[name] = { command: h.command, model: h.model, about: h.about ?? name };
    }
  } catch {
    // none, or not JSON: the known ones
  }
  return Object.fromEntries(Object.entries(all).filter(([, h]) => h.command[0] !== undefined && which(h.command[0]) !== null));
}

/** Runs it in the foreground: its output (cut to the end that matters), honoring the signal. */
function runNow(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((done) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (chunk: string): void => void (out = (out + chunk).slice(-MAX_OUTPUT * 2));
    child.stdout.setEncoding("utf8").on("data", take);
    child.stderr.setEncoding("utf8").on("data", take);
    const stop = (): void => {
      try {
        process.kill(-(child.pid ?? 0), "SIGTERM");
      } catch {
        // gone
      }
    };
    const timer = setTimeout(stop, WAIT_MS);
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", (e) => done(`ERROR: delegate: could not start ${args[0]}: ${e.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) return done("Aborted by user");
      // Colours and cursor moves (an agent that styles its output for a terminal) are noise here.
      // oxlint-disable-next-line no-control-regex -- terminal escape sequences are what is cut
      const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      const tail = plain.length > MAX_OUTPUT ? `…${plain.slice(-MAX_OUTPUT)}` : plain;
      done(code === 0 ? tail.trim() || "(it answered nothing)" : `ERROR: delegate: ${args[0]} exited with ${code}\n${tail.trim()}`);
    });
  });
}

export async function install(k: Kinoko, opts: Options = {}): Promise<void> {
  const home = opts.home ?? process.env.HOME ?? "";
  const which = opts.which ?? ((bin: string) => Bun.which(bin));
  const found = await harnesses(home, which);
  const names = Object.keys(found);
  if (names.length === 0) {
    k.log("delegate: no other coding agent installed (opencode, pi, claude, codex, kinoko)");
    return;
  }
  k.registerTool({
    name: "delegate",
    description: [
      "Hand a task to another coding agent, run non-interactively in this project:",
      ...names.map((n) => `${n}: ${found[n]!.about}`),
      "It runs as a background job: end your reply; you get a message with its answer when it finishes, and do what comes next then.",
      "It knows nothing of this conversation: give it everything it needs in the task.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        to: { type: "string", enum: names, description: "which agent" },
        task: { type: "string", description: "the whole task, self-contained" },
        model: { type: "string", description: "its model, in its own naming (default: its own default)" },
      },
      required: ["to", "task"],
    },
    readOnly: false,
    run: async (args: { to?: unknown; task?: unknown; model?: unknown }, ctx: ToolContext) => {
      const h = typeof args.to === "string" ? found[args.to] : undefined;
      if (h === undefined) return `ERROR: delegate: to must be one of ${names.join(", ")}`;
      if (typeof args.task !== "string" || args.task.trim() === "") return "ERROR: delegate: missing task (string)";
      const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
      const command = argv(h, args.task.trim(), model);
      if (ctx.background === undefined) return runNow(command, ctx.cwd, ctx.signal);
      const job = ctx.background(command.map(shellQuote).join(" "));
      return [
        `${args.to} is working on it as background job #${job.id} (its output: ${job.log}; the TUI shows it under ⚙ shells).`,
        "Do not wait or poll: end your reply. When it finishes you get a message with its answer (its last lines; the whole of it in the log).",
      ].join("\n");
    },
  });
}

export default async function (k: Kinoko): Promise<void> {
  await install(k);
}
