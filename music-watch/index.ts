// Watch for song changes in cliamp. The model uses this to auto-detect when the user
// changes music, so it can update the todo list and start a new watch.
//
//   watch: polls cliamp's runtime.snapshot every 3s; when the track title changes,
//   returns the new song info. The model should then update its todo list and call
//   watch again with the new song as baseline.
//
// Usage: the model calls this after any music change, then loops:
//   1. Call watch() → gets new song
//   2. Update todo list with new song
//   3. Call watch() again with the new song as baseline
//   Repeat until the user stops listening or changes the watch.

import type { Kinoko, ToolContext } from "../api.ts";
import { runCliamp, type Cliamp } from "../cliamp/index.ts";

interface WatchState {
  cliamp: Cliamp;
  lastSong: string;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Get the current track title from cliamp's snapshot. */
async function currentTrack(m: WatchState, signal: AbortSignal): Promise<string | null> {
  // oxlint-disable-next-line no-await-in-loop -- sequential, with abort
  const res = await Promise.race([
    m.cliamp(["remote", "call", "--wait", "runtime.snapshot", "--params", "{}"], signal),
    new Promise<{ code: number; out: string }>((_, rej) => {
      const t = setTimeout(() => rej(new Error("cliamp timeout")), 5000);
      signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
    }),
  ]);
  try {
    const data = JSON.parse(res.out) as Record<string, unknown>;
    const job = (data.job ?? data) as Record<string, unknown>;
    const snapshot = (job.snapshot ?? {}) as Record<string, unknown>;
    const track = (snapshot.logical_track ?? {}) as Record<string, unknown>;
    const title = track.title as string;
    return title || null;
  } catch {
    return null;
  }
}

/** Check if cliamp is running. */
async function isRunning(m: WatchState, signal: AbortSignal): Promise<boolean> {
  // oxlint-disable-next-line no-await-in-loop -- sequential, with abort
  const res = await Promise.race([
    m.cliamp(["status"], signal),
    new Promise<{ code: number; out: string }>((_, rej) => {
      const t = setTimeout(() => rej(new Error("cliamp timeout")), 5000);
      signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
    }),
  ]);
  return !res.out.includes("not running");
}

export async function watch(args: { timeout?: number; interval?: number }, ctx: ToolContext): Promise<string> {
  try {
    const timeout = Math.min(Math.max(Number(args.timeout ?? 600), 10), 3600) * 1000; // seconds, clamped 10s-1h
    const interval = Math.min(Math.max(Number(args.interval ?? 3), 1), 10); // seconds, clamped 1-10
    const signal = ctx.signal;

  const m: WatchState = {
    cliamp: runCliamp,
    lastSong: "",
    sleep: (ms, sig) => new Promise((done) => {
      const t = setTimeout(done, ms);
      sig.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
    }),
  };

  // Check if cliamp is running
  if (!(await isRunning(m, signal))) {
    return "cliamp is not running (play something to start it)";
  }

  // Get the current song as baseline
  const initial = await currentTrack(m, signal);
  if (!initial) {
    return "could not read current song from cliamp";
  }

  const startTime = Date.now();
  let polled = 0;

  while (!signal.aborted) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      return `watch timed out after ${Math.round(timeout / 1000)}s — still playing: ${initial}`;
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential polling
    await m.sleep(interval * 1000, signal);
    polled++;

    // oxlint-disable-next-line no-await-in-loop -- sequential polling
    const current = await currentTrack(m, signal);
    if (!current) {
      // Song might have stopped; check again
      // oxlint-disable-next-line no-await-in-loop -- sequential polling
      await m.sleep(interval * 1000, signal);
      // oxlint-disable-next-line no-await-in-loop -- sequential polling
      const next = await currentTrack(m, signal);
      if (next && next !== initial) {
        return `song changed to: ${next}`;
      }
      continue;
    }

    if (current !== initial) {
      return `song changed to: ${current}`;
    }
  }

  return `watch cancelled — still playing: ${initial}`;
  } catch (e) {
    return `ERROR: music_watch: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export default function (k: Kinoko): void {
  k.registerTool({
    name: "music_watch",
    description:
      "Watch for song changes in cliamp. Polls the player and returns when the track changes. Use this to auto-detect when music changes so you can update the todo list. Returns the new song title when changed, or the current song if timeout is reached.",
    schema: {
      type: "object",
      properties: {
        timeout: {
          type: "number",
          description: "Max seconds to wait (default 600, max 3600). After timeout, returns the current song.",
        },
        interval: {
          type: "number",
          description: "Seconds between checks (default 3, min 1, max 10). Lower = more responsive but more cliamp calls.",
        },
      },
    },
    readOnly: true,
    run: async (args: Record<string, unknown>, ctx: ToolContext) => watch(args as { timeout?: number; interval?: number }, ctx),
  });
}
