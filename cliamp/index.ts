// Music through cliamp (the retro terminal player): play, pause, skip, volume, seek, the queue,
// radio stations, songs and folders from ~/Music, YouTube (searched with yt-dlp, never downloaded).
// Talks to a running cliamp over its IPC API (`cliamp remote call`); when none runs, starts one in
// the background (`cliamp --daemon`).

import { homedir } from "node:os";
import { join } from "node:path";
import type { Kinoko, ToolContext } from "../api.ts";
import { findSongs, folderOf, songsIn } from "./library.ts";
import { clock, isPlaylist, otherResults, youtube } from "./youtube.ts";
import type { YouTube } from "./youtube.ts";

export { findSongs, songsIn } from "./library.ts";

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
  youtube: YouTube;
  /** cliamp's log: why something did not play is only written there. */
  log: string;
}

const defaults: Music = {
  cliamp: runCliamp,
  start: () => void Bun.spawn(["setsid", "-f", "cliamp", "--daemon", "--no-auto-play"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  library: process.env.XDG_MUSIC_DIR || join(homedir(), "Music"),
  youtube,
  log: join(homedir(), ".config", "cliamp", "cliamp.log"),
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

/** Takes the songs whose file is gone (moved, deleted) out of the playlist: cliamp stops on them. */
async function prune(m: Music, signal: AbortSignal): Promise<string> {
  const { result } = await call(m, "queue.list", { offset: 0, limit: 1000 }, signal);
  const tracks = Array.isArray(result.tracks) ? (result.tracks as Json[]) : [];
  const local = (t: Json): boolean => !t.stream && str(t.path).startsWith("/");
  const kept = await Promise.all(tracks.map(async (t) => !local(t) || (await Bun.file(str(t.path)).exists())));
  const gone = kept.flatMap((ok, i) => (ok ? [] : [i])).toReversed(); // from the end, so the places before hold
  for (const index of gone) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time: each removal moves the places after it
    await call(m, "queue.remove", { index }, signal);
  }
  return gone.length === 0 ? "" : `took ${gone.length} songs whose files are gone (moved or deleted) out of the playlist`;
}

/** Why cliamp did not play `target`: the last line its log wrote about it. */
async function whyNot(m: Music, target: string): Promise<string> {
  const lines = (await Bun.file(m.log).text().catch(() => "")).split("\n").slice(-200);
  const line = lines.findLast((l) => l.includes(target)) ?? "";
  return /msg="(.*)"$/.exec(line)?.[1]?.replaceAll('\\"', '"') ?? "";
}

const ACTIONS = ["status", "play", "pause", "toggle", "next", "prev", "stop", "volume", "seek", "queue", "remove", "clear", "list", "find", "youtube", "radio", "shuffle", "repeat", "eq", "history"];

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
    // Moving through the playlist never lands on a song whose file is gone.
    const pruned = ["play", "queue", "next", "prev", "list", "remove", "youtube"].includes(action) ? await prune(m, signal) : "";
    const ok = (snapshot: Json, note = ""): string => [pruned, note, describe(snapshot)].filter(Boolean).join("\n");

    // At cliamp's top: louder is the speaker's own (system) volume.
    const loud = (snapshot: Json): string => ok(snapshot, Number(snapshot.volume) >= 6 ? "cliamp is at its maximum (6 dB); louder: the system volume, bash `pactl set-sink-volume @DEFAULT_SINK@ +10%`" : "");
    // Appends paths in order and plays the first of them when asked.
    const addAll = async (paths: string[], play: boolean, label: string): Promise<string> => {
      let { snapshot } = await call(m, "runtime.snapshot", {}, signal);
      const first = Number(snapshot.total ?? 0);
      for (const path of paths) {
        // oxlint-disable-next-line no-await-in-loop -- appended in order, one after the other
        ({ snapshot } = await call(m, "queue", { path }, signal));
      }
      if (!play) return ok(snapshot, `queued ${label}`);
      ({ snapshot } = await call(m, "queue.play", { index: first }, signal));
      // A stream (YouTube) takes a moment to start; one that never does says why in cliamp's log.
      for (let i = 0; i < 16 && snapshot.state !== "playing" && !signal.aborted; i++) {
        // oxlint-disable-next-line no-await-in-loop -- waiting for playback, a beat at a time
        await m.sleep(500, signal);
        // oxlint-disable-next-line no-await-in-loop -- same wait
        ({ snapshot } = await call(m, "runtime.snapshot", {}, signal));
      }
      if (snapshot.state === "playing") return ok(snapshot, `playing ${label}`);
      const why = await whyNot(m, paths[0] ?? "");
      return `ERROR: music: ${label} did not start${why ? `: ${why}` : ""}\n${describe(snapshot)}`;
    };

    switch (action) {
      case "status":
        return ok((await call(m, "runtime.snapshot", {}, signal)).snapshot);
      case "next":
      case "prev": {
        const { snapshot } = await call(m, action, {}, signal);
        const index = Number(snapshot.index);
        const edge = action === "next" ? index >= Number(snapshot.total) - 1 : index <= 0;
        return ok(snapshot, snapshot.state !== "playing" && edge ? `nothing ${action === "next" ? "after" : "before"} this one: the playlist ${action === "next" ? "ended" : "starts here"}` : "");
      }
      case "pause":
      case "toggle":
      case "stop":
        return ok((await call(m, action, {}, signal)).snapshot);
      case "volume": {
        // A plain number is the level (dB are mostly negative); up/down or +N change it.
        const change = /^(up|down)(?:\s+(\d+(?:\.\d+)?))?$/i.exec(value);
        if (change) return loud((await call(m, "volume.adjust", { value: (change[1]?.toLowerCase() === "up" ? 1 : -1) * Number(change[2] ?? 3) }, signal)).snapshot);
        if (/^\+\d+(\.\d+)?$/.test(value)) return loud((await call(m, "volume.adjust", { value: Number(value) }, signal)).snapshot);
        if (!/^-?\d+(\.\d+)?$/.test(value)) return 'ERROR: music: volume needs a level in dB, -30 to 6 ("-10"), or a change ("up", "down 5", "+3")';
        return loud((await call(m, "volume", { value: Number(value) }, signal)).snapshot);
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
        // A folder: every song in it, the first played.
        const folder = await folderOf(m.library, query);
        if (folder) {
          const songs = await songsIn(folder);
          if (songs.length === 0) return `no songs in ${folder}`;
          return addAll(songs, play, `${songs.length} songs from ${folder.replace(/\/+$/, "").split("/").at(-1)}`);
        }
        // A URL or a path as it is; otherwise songs from the library by name: the best match, or
        // with all every one. Appended to the playlist (url.load would start playing even when
        // told not to), then played by its place when asked.
        const path = query.replace(/^~(?=\/)/, homedir());
        if (isPlaylist(query)) return addAll((await m.youtube.playlist(query, signal)).map((v) => v.url), play, `the YouTube playlist (${query})`);
        if (/^https?:\/\//.test(query) || (await Bun.file(path).exists())) return addAll([path], play, path.split("/").at(-1) ?? path);
        const songs = await findSongs(m.library, query, args.all === true ? 100 : 5);
        if (songs.length === 0) return `nothing in ${m.library} matches "${query}" (youtube searches YouTube, radio searches stations)`;
        if (args.all === true) return addAll(songs, play, `${songs.length} songs matching "${query}"`);
        const also = songs.length > 1 ? `\nalso matching (all: true takes every one):\n${songs.slice(1).map((s) => `  ${s}`).join("\n")}` : "";
        return `${await addAll(songs.slice(0, 1), play, songs[0]?.split("/").at(-1) ?? "")}${also}`;
      }
      case "youtube": {
        if (!query) return "ERROR: music: youtube needs a query (a song, an artist)";
        // all: a whole playlist (an album, a soundtrack), its videos queued in order.
        if (args.all === true) {
          const [list, ...others] = await m.youtube.playlists(query, signal);
          if (!list) return `no YouTube playlist for "${query}"`;
          const videos = await m.youtube.playlist(list.url, signal);
          if (videos.length === 0) return `the YouTube playlist "${list.title}" is empty${otherResults(others, "playlists")}`;
          return `${await addAll(videos.map((v) => v.url), true, `${videos.length} videos of the YouTube playlist "${list.title}"`)}${otherResults(others, "playlists")}`;
        }
        const [first, ...others] = await m.youtube.videos(query, signal);
        if (!first) return `nothing on YouTube for "${query}"`;
        return `${await addAll([first.url], true, `${first.title}${first.seconds ? ` (${clock(first.seconds)})` : ""} from YouTube`)}${otherResults(others, "videos")}`;
      }
      case "remove": {
        // By its number in list, or the first whose title holds the query.
        const { result } = await call(m, "queue.list", { offset: 0, limit: 1000 }, signal);
        const tracks = Array.isArray(result.tracks) ? (result.tracks as Json[]) : [];
        const name = (t: Json): string => str(t.title) || str(t.path);
        const index = typeof args.index === "number" ? Math.trunc(args.index) : tracks.findIndex((t) => query !== "" && name(t).toLowerCase().includes(query.toLowerCase()));
        const track = tracks[index];
        if (!track) return `ERROR: music: remove needs a playlist number (list) or part of a title${query ? `: nothing called "${query}"` : ""}`;
        return ok((await call(m, "queue.remove", { index }, signal)).snapshot, `removed ${index}. ${name(track)}`);
      }
      case "clear":
        return ok((await call(m, "queue.clear", {}, signal)).snapshot, "the playlist is empty now");
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
      "Control music in cliamp: status; play (a song from ~/Music by name, with all: true every song matching it, a folder for all its songs (its path, or its name in ~/Music: an artist's discography), a path, a URL, or a playlist index; nothing resumes), queue, pause, toggle, next, prev, stop; youtube (search YouTube and play the first video, no download; with all: true a whole YouTube playlist: an album, a soundtrack; never guess a YouTube link, and to add one it found without stopping the music, queue its link); remove (a playlist number or part of a title), clear (empty the playlist); volume (a level in dB, -30 to 6, or up/down), seek (seconds, or +30/-10); list the playlist; find songs; radio (search stations by genre or name and play one); shuffle, repeat, eq (preset); history. This is a kinoko tool, not a shell command: in bash or a background job, use `cliamp status` (its `Track:` line is the song playing).",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS },
        query: { type: "string", description: "play/queue: a song's name, a folder, a path or a URL; find/youtube/radio: what to look for; remove: part of a title" },
        value: { type: "string", description: 'volume ("-10", "up", "down 5"), seek ("90", "+30"), shuffle (on/off), repeat (off/all/one), eq (preset)' },
        index: { type: "number", description: "play/remove: a track of the playlist, by its number in list" },
        all: { type: "boolean", description: "play/queue: every song in ~/Music matching query, not only the best; youtube: a whole playlist (album, soundtrack)" },
      },
      required: ["action"],
    },
    readOnly: true,
    run: async (args: Json, ctx: ToolContext) => music(args, ctx),
  });
}
