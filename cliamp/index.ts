// Music through cliamp (the retro terminal player): play, pause, skip, volume, seek, the queue,
// radio stations, songs from ~/Music by name. Talks to a running cliamp over its IPC API
// (`cliamp remote call`); when none runs, starts one in the background (`cliamp --daemon`).

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Kinoko, ToolContext } from "../api.ts";

const AUDIO = /\.(mp3|flac|ogg|opus|m4a|aac|wav|webm|wma|aiff?|mka)$/i;

export type Cliamp = (args: string[], signal: AbortSignal) => Promise<{ code: number; out: string }>;

export const runCliamp: Cliamp = async (args, signal) => {
  try {
    const proc = Bun.spawn(["cliamp", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out: `${out}${err}`.trim() };
  } catch {
    return { code: 127, out: "cliamp is not installed (https://github.com/bjarneo/cliamp)" };
  }
};

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export interface Music {
  cliamp: Cliamp;
  /** Starts a cliamp in the background, detached from kinoko. */
  start: () => void;
  /** Where songs are looked for by name. */
  library: string;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaults: Music = {
  cliamp: runCliamp,
  start: () => void Bun.spawn(["setsid", "-f", "cliamp", "--daemon", "--no-auto-play"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  library: process.env.XDG_MUSIC_DIR || join(homedir(), "Music"),
  sleep: (ms, signal) => new Promise((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  }),
};

/** One IPC operation, waited for: its result and the player's state after it. */
async function call(m: Music, op: string, params: Json, signal: AbortSignal): Promise<{ result: Json; snapshot: Json }> {
  const res = await m.cliamp(["remote", "call", "--wait", op, "--params", JSON.stringify(params)], signal);
  if (res.code === 127) throw new Error(res.out);
  let data: Json;
  try {
    data = JSON.parse(res.out) as Json;
  } catch {
    throw new Error(res.out.split("\n").at(-1) || `cliamp ${op} failed`);
  }
  // Most operations are jobs (waited for); a few answer at once, without one.
  const job = (data.job ?? data) as Json;
  if (job.state === "failed" || data.ok === false) throw new Error(str((job.error as Json | undefined)?.message) || str(job.error) || `cliamp ${op} failed`);
  return { result: (job.result ?? {}) as Json, snapshot: (job.snapshot ?? data.snapshot ?? {}) as Json };
}

/** A running cliamp, started when there is none: true when one answers. */
async function ensure(m: Music, signal: AbortSignal, start: boolean): Promise<boolean> {
  const running = async (): Promise<boolean> => !/not running/.test((await m.cliamp(["status"], signal)).out);
  if (await running()) return true;
  if (!start) return false;
  m.start();
  for (let i = 0; i < 20 && !signal.aborted; i++) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for the daemon's socket, a beat at a time
    await m.sleep(150, signal);
    // oxlint-disable-next-line no-await-in-loop -- same wait
    if (await running()) return true;
  }
  return false;
}

/** "▶ Glue Gun · vol -10 dB · shuffle off" */
export function describe(s: Json): string {
  const track = (s.logical_track ?? s.track ?? {}) as Json;
  const state = str(s.state);
  const icon = state === "playing" ? "▶" : state === "paused" ? "⏸" : "■";
  const title = str(track.title) || str(track.path).split("/").at(-1) || "nothing loaded";
  const extras = [`vol ${str(s.volume) || "?"} dB`, s.shuffle ? "shuffle on" : "", str(s.repeat) && str(s.repeat) !== "Off" ? `repeat ${str(s.repeat).toLowerCase()}` : "", str(s.eq_preset) && s.eq_preset !== "Custom" ? `eq ${str(s.eq_preset)}` : ""];
  return `${icon} ${state || "stopped"}: ${title}${track.stream ? " (stream)" : ""} · ${extras.filter(Boolean).join(" · ")} · ${str(s.total) || 0} in the playlist`;
}

/** Songs under the library whose path holds every word of the query. */
export async function findSongs(library: string, query: string, limit = 10): Promise<string[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const files = (await readdir(library, { recursive: true }).catch(() => [] as string[])).filter((f) => AUDIO.test(f)).slice(0, 20_000);
  return files.filter((f) => words.every((w) => f.toLowerCase().includes(w))).toSorted((a, b) => a.length - b.length).slice(0, limit).map((f) => join(library, f));
}

const ACTIONS = ["status", "play", "pause", "toggle", "next", "prev", "stop", "volume", "seek", "queue", "list", "find", "radio", "shuffle", "repeat", "eq", "history"];

export async function music(args: Json, ctx: ToolContext, m: Music = defaults): Promise<string> {
  const action = str(args.action);
  const value = str(args.value).trim();
  const query = str(args.query).trim();
  if (!ACTIONS.includes(action)) return `ERROR: music: action is one of ${ACTIONS.join(", ")}`;
  const signal = ctx.signal;
  try {
    if (action === "find") {
      if (!query) return "ERROR: music: find needs a query";
      const songs = await findSongs(m.library, query);
      return songs.length === 0 ? `nothing in ${m.library} matches "${query}" (try radio)` : songs.join("\n");
    }
    const starting = action === "play" || action === "queue" || action === "radio";
    if (!(await ensure(m, signal, starting))) return starting ? "ERROR: music: cliamp did not start" : "cliamp is not running (play something to start it)";
    const ok = (snapshot: Json, note = ""): string => `${note ? `${note}\n` : ""}${describe(snapshot)}`;

    switch (action) {
      case "status":
        return ok((await call(m, "runtime.snapshot", {}, signal)).snapshot);
      case "pause":
      case "toggle":
      case "next":
      case "prev":
      case "stop":
        return ok((await call(m, action, {}, signal)).snapshot);
      case "volume": {
        // A plain number is the level (dB are mostly negative); up/down or +N change it.
        const change = /^(up|down)(?:\s+(\d+(?:\.\d+)?))?$/i.exec(value);
        if (change) return ok((await call(m, "volume.adjust", { value: (change[1]?.toLowerCase() === "up" ? 1 : -1) * Number(change[2] ?? 3) }, signal)).snapshot);
        if (/^\+\d+(\.\d+)?$/.test(value)) return ok((await call(m, "volume.adjust", { value: Number(value) }, signal)).snapshot);
        if (!/^-?\d+(\.\d+)?$/.test(value)) return 'ERROR: music: volume needs a level in dB, -30 to 6 ("-10"), or a change ("up", "down 5", "+3")';
        return ok((await call(m, "volume", { value: Number(value) }, signal)).snapshot);
      }
      case "seek": {
        const secs = Number(value.replace(/^\+/, ""));
        if (!Number.isFinite(secs)) return 'ERROR: music: seek needs seconds: "90" to go there, "+30" or "-10" to move';
        return ok((await call(m, /^[+-]/.test(value) ? "seek" : "seek.absolute", { value: secs }, signal)).snapshot);
      }
      case "shuffle":
      case "repeat":
      case "eq":
        if (!value) return `ERROR: music: ${action} needs a value (${action === "shuffle" ? "on/off" : action === "repeat" ? "off/all/one" : "a preset name"})`;
        return ok((await call(m, action, { name: value }, signal)).snapshot);
      case "list": {
        const { result, snapshot } = await call(m, "queue.list", { offset: 0, limit: 50 }, signal);
        const tracks = Array.isArray(result.tracks) ? (result.tracks as Json[]) : [];
        return ok(snapshot, tracks.map((t, i) => `${i}. ${str(t.title) || str(t.path)}`).join("\n") || "the playlist is empty");
      }
      case "history": {
        const { result } = await call(m, "runtime.history", { limit: 15 }, signal);
        const items = (Array.isArray(result.history) ? result.history : Array.isArray(result.tracks) ? result.tracks : []) as Json[];
        return items.map((t) => str(t.title) || str(t.path)).join("\n") || "nothing played yet";
      }
      case "radio": {
        if (!query) return "ERROR: music: radio needs a query (a genre, a station's name)";
        const { result } = await call(m, "provider.search", { provider: "radio", query, limit: 8 }, signal);
        const stations = Array.isArray(result.tracks) ? (result.tracks as Json[]) : [];
        if (stations.length === 0) return `no radio station for "${query}"`;
        const first = stations[0] ?? {};
        const { snapshot } = await call(m, "url.load", { path: str(first.path), play: true }, signal);
        return ok(snapshot, `playing ${str(first.title)}; others:\n${stations.slice(1).map((s) => `  ${str(s.title)} — ${str(s.path)}`).join("\n")}`);
      }
      case "play":
      case "queue": {
        const play = action === "play";
        if (typeof args.index === "number") return ok((await call(m, "queue.play", { index: Math.trunc(args.index) }, signal)).snapshot);
        if (!query) return play ? ok((await call(m, "play", {}, signal)).snapshot) : "ERROR: music: queue needs a query (a song's name, a path or a URL)";
        // A URL or a path as it is; otherwise a song from the library by name.
        let target = query;
        let note = "";
        if (!/^https?:\/\//.test(query) && !(await Bun.file(query.replace(/^~(?=\/)/, homedir())).exists())) {
          const songs = await findSongs(m.library, query, 5);
          if (songs.length === 0) return `nothing in ${m.library} matches "${query}" (radio searches stations)`;
          target = songs[0] ?? "";
          if (songs.length > 1) note = `also matching:\n${songs.slice(1).map((s) => `  ${s}`).join("\n")}`;
        } else target = query.replace(/^~(?=\/)/, homedir());
        // Appended to the playlist (url.load would start playing even when told not to), then
        // played by its place when asked.
        let { snapshot } = await call(m, "queue", { path: target }, signal);
        if (play) ({ snapshot } = await call(m, "queue.play", { index: Number(snapshot.total ?? 1) - 1 }, signal));
        return ok(snapshot, `${play ? "playing" : "queued"} ${target.split("/").at(-1)}${note ? `\n${note}` : ""}`);
      }
      default:
        return `ERROR: music: ${action}`;
    }
  } catch (e) {
    if (signal.aborted) throw e;
    return `ERROR: music: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export default function (k: Kinoko): void {
  k.registerTool({
    name: "music",
    description:
      "Control music in cliamp: status; play (a song from ~/Music by name, a path, a URL, or a playlist index; nothing resumes), queue, pause, toggle, next, prev, stop; volume (a level in dB, -30 to 6, or up/down), seek (seconds, or +30/-10); list the playlist; find songs; radio (search stations by genre or name and play one); shuffle, repeat, eq (preset); history.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS },
        query: { type: "string", description: "play/queue: a song's name, a path or a URL; find/radio: what to look for" },
        value: { type: "string", description: 'volume ("-10", "up", "down 5"), seek ("90", "+30"), shuffle (on/off), repeat (off/all/one), eq (preset)' },
        index: { type: "number", description: "play: a track of the playlist, by its number in list" },
      },
      required: ["action"],
    },
    readOnly: true,
    run: async (args: Json, ctx: ToolContext) => music(args, ctx),
  });
}
