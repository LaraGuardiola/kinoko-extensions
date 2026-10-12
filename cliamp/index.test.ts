import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../testing/bus.ts";
import install, { describe as describeState, findSongs, music, songsIn } from "./index.ts";
import type { Music } from "./index.ts";

const ctx = { signal: new AbortController().signal, cwd: "/" };
const library = mkdtempSync(join(tmpdir(), "kinoko-music-"));
mkdirSync(join(library, "Fox Stevenson"));
for (const f of ["Fox Stevenson/Glue Gun.mp3", "Fox Stevenson/Killjoy.flac", "Other - Glue Factory.ogg", "cover.jpg"]) writeFileSync(join(library, f), "");
afterAll(() => rmSync(library, { recursive: true, force: true }));

/** A cliamp that keeps a little state; `running` false until started. */
function fake(running = true): { m: Music; ops: Array<[string, unknown]>; started: () => boolean } {
  const ops: Array<[string, unknown]> = [];
  let up = running;
  let didStart = false;
  // The live playlist: two streams to start with.
  const tracks: Array<{ path: string; stream?: boolean }> = [{ path: "http://lofi", stream: true }, { path: "http://synth", stream: true }];
  const state = { state: "stopped", volume: -10, total: 2, index: 0, logical_track: { title: "Lofi Stream", stream: true } as Record<string, unknown> };
  const at = (i: number): void => {
    // Like cliamp: a song whose file is gone does not play.
    const t = tracks[i];
    state.index = i;
    state.logical_track = { path: t?.path, stream: t?.stream };
    state.state = t && (t.path.startsWith("http") ? !t.path.endsWith("gone") : existsSync(t.path)) ? "playing" : "stopped";
  };
  const m: Music = {
    library,
    log: join(library, "cliamp.log"),
    youtube: {
      videos: async (q) => (q === "nothing" ? [] : [{ url: `https://yt/${q.includes("gone") ? "gone" : "ok"}`, title: "I Want It That Way", seconds: 220 }, { url: "https://yt/2", title: "Lyrics", seconds: 212 }]),
      playlists: async () => [{ url: "https://www.youtube.com/playlist?list=OST", title: "FighterZ OST", seconds: 0 }, { url: "https://www.youtube.com/playlist?list=B", title: "Other OST", seconds: 0 }],
      playlist: async () => [{ url: "https://yt/main", title: "Main Theme", seconds: 127 }, { url: "https://yt/lobby", title: "Lobby", seconds: 347 }],
    },
    start: () => {
      didStart = true;
      up = true;
    },
    sleep: async () => undefined,
    cliamp: async (args) => {
      if (args[0] === "status") return { code: 0, out: up ? "playing" : "cliamp is not running (no socket)" };
      const op = args[3] ?? "";
      const params = JSON.parse(args[5] ?? "{}") as Record<string, unknown>;
      ops.push([op, params]);
      if (op === "queue") tracks.push({ path: String(params.path) });
      if (op === "queue.remove") tracks.splice(Number(params.index), 1);
      if (op === "volume") state.volume = Math.min(6, Number(params.value));
      if (op === "queue.play") at(Number(params.index));
      if (op === "next") at(state.index + 1 < tracks.length ? state.index + 1 : -1);
      if (op === "next" && state.index === -1) Object.assign(state, { index: tracks.length - 1, state: "stopped" });
      state.total = tracks.length;
      if (op === "queue.list") {
        const from = Number(params.offset ?? 0);
        const page = tracks.slice(from, from + Number(params.limit ?? 50));
        return { code: 0, out: JSON.stringify({ ok: true, job: { state: "succeeded", result: { tracks: page }, snapshot: state } }) };
      }
      if (op === "volume.adjust") state.volume += Number(params.value);
      if (op === "provider.search") return { code: 0, out: JSON.stringify({ ok: true, job: { state: "succeeded", result: { tracks: [{ title: "Jazz FM", path: "http://jazz" }] }, snapshot: state } }) };
      if (op === "runtime.snapshot") return { code: 0, out: JSON.stringify({ ok: true, snapshot: state }) }; // answered at once, no job
      if (op === "eq") return { code: 0, out: JSON.stringify({ ok: true, job: { state: "failed", error: { message: 'unknown preset "Nope"' } } }) };
      return { code: 0, out: JSON.stringify({ ok: true, job: { state: "succeeded", result: {}, snapshot: state } }) };
    },
  };
  return { m, ops, started: () => didStart };
}

describe("cliamp", () => {
  test("registers the music tool", () => {
    const bus = new Bus();
    install(bus);
    expect(bus.tools().map((t) => t.name)).toEqual(["music"]);
  });

  test("songs by name: every word in the path, audio files only, the shortest first", async () => {
    expect(await findSongs(library, "glue")).toEqual([join(library, "Other - Glue Factory.ogg"), join(library, "Fox Stevenson/Glue Gun.mp3")]);
    expect(await findSongs(library, "fox killjoy")).toEqual([join(library, "Fox Stevenson/Killjoy.flac")]);
    expect(await findSongs(library, "cover")).toEqual([]);
  });

  test("play by name: appended to the playlist, then played by its place (cliamp started when not running)", async () => {
    const { m, ops, started } = fake(false);
    const out = await music({ action: "play", query: "glue gun" }, ctx, m);
    expect(started()).toBe(true);
    expect(ops.filter(([op]) => op === "queue" || op === "queue.play")).toEqual([["queue", { path: join(library, "Fox Stevenson/Glue Gun.mp3") }], ["queue.play", { index: 2 }]]);
    expect(out).toStartWith("playing Glue Gun.mp3\n▶ playing:");
  });

  test("a folder, by its name in the library: every song in it queued and the first played", async () => {
    const { m, ops } = fake();
    expect(await songsIn(join(library, "Fox Stevenson"))).toEqual([join(library, "Fox Stevenson/Glue Gun.mp3"), join(library, "Fox Stevenson/Killjoy.flac")]);
    const out = await music({ action: "play", query: "fox stevenson" }, ctx, m);
    expect(ops.filter(([op]) => op === "queue" || op === "queue.play").map(([, p]) => p)).toEqual([{ path: join(library, "Fox Stevenson/Glue Gun.mp3") }, { path: join(library, "Fox Stevenson/Killjoy.flac") }, { index: 2 }]);
    expect(out).toStartWith("playing 2 songs from Fox Stevenson\n▶ playing:");
    expect(await music({ action: "play", query: `${join(library, "Fox Stevenson")}/` }, ctx, m)).toStartWith("playing 2 songs from Fox Stevenson\n");
    // next plays the second; after the last one it says the playlist ended.
    expect(await music({ action: "next" }, ctx, m)).toStartWith("▶ playing:");
    expect(await music({ action: "next" }, ctx, m)).toStartWith("nothing after this one: the playlist ended\n■ stopped");
  });

  test("songs whose files were moved away are taken out of the playlist before next lands on them", async () => {
    const { m, ops } = fake();
    await music({ action: "queue", query: join(library, "Other - Glue Factory.ogg") }, ctx, m);
    await music({ action: "queue", query: join(library, "Fox Stevenson/Glue Gun.mp3") }, ctx, m);
    await music({ action: "play", index: 2 }, ctx, m);
    // Moved out of the library after it was queued: cliamp would stop on it.
    rmSync(join(library, "Other - Glue Factory.ogg"));
    const out = await music({ action: "next" }, ctx, m);
    expect(ops).toContainEqual(["queue.remove", { index: 2 }]);
    expect(out).toStartWith("took 1 songs whose files are gone (moved or deleted) out of the playlist\n");
    writeFileSync(join(library, "Other - Glue Factory.ogg"), "");
  });

  test("youtube: searched, the first played without download; one that does not start says why", async () => {
    const { m, ops } = fake();
    const out = await music({ action: "youtube", query: "backstreet boys" }, ctx, m);
    expect(ops).toContainEqual(["queue", { path: "https://yt/ok" }]);
    expect(out).toBe("playing I Want It That Way (3:40) from YouTube\n▶ playing: undefined · vol -10 dB · 3 in the playlist\nother videos (queue one with its link to add it after, play to switch to it):\n  Lyrics (3:32) https://yt/2".replace("undefined", "ok"));
    writeFileSync(join(library, "cliamp.log"), 'time=1 level=WARN msg="daemon: play \\"https://yt/gone\\": yt-dlp: ERROR: This video is unavailable"\n');
    expect(await music({ action: "youtube", query: "gone" }, ctx, m)).toStartWith('ERROR: music: I Want It That Way (3:40) from YouTube did not start: daemon: play "https://yt/gone": yt-dlp: ERROR: This video is unavailable\n');
    expect(await music({ action: "youtube", query: "nothing" }, ctx, m)).toBe('nothing on YouTube for "nothing"');
  });

  test("youtube with all: a whole playlist queued in order and the first played; a playlist link queues all of it", async () => {
    const { m, ops } = fake();
    const out = await music({ action: "youtube", query: "fighterz ost", all: true }, ctx, m);
    expect(ops.filter(([op]) => op === "queue" || op === "queue.play").map(([, p]) => p)).toEqual([{ path: "https://yt/main" }, { path: "https://yt/lobby" }, { index: 2 }]);
    expect(out).toStartWith('playing 2 videos of the YouTube playlist "FighterZ OST"\n▶ playing');
    expect(out).toEndWith("other playlists (queue one with its link to add it after, play to switch to it):\n  Other OST https://www.youtube.com/playlist?list=B");
    expect(await music({ action: "queue", query: "https://www.youtube.com/playlist?list=B" }, ctx, m)).toStartWith("queued the YouTube playlist");
    expect(ops.slice(-2)).toEqual([["queue", { path: "https://yt/main" }], ["queue", { path: "https://yt/lobby" }]]);
  });

  test("by name, all: true takes every match; remove by title or number; clear", async () => {
    const { m, ops } = fake();
    expect(await music({ action: "queue", query: "glue", all: true }, ctx, m)).toStartWith('queued 2 songs matching "glue"');
    expect(await music({ action: "play", query: "glue" }, ctx, m)).toContain("also matching (all: true takes every one):");
    expect(await music({ action: "remove", query: "factory" }, ctx, m)).toStartWith("removed 2. ");
    expect(await music({ action: "remove", index: 0 }, ctx, m)).toStartWith("removed 0. http://lofi");
    expect(await music({ action: "remove", query: "toaster" }, ctx, m)).toContain('nothing called "toaster"');
    expect(await music({ action: "clear" }, ctx, m)).toStartWith("the playlist is empty now");
    expect(ops.at(-1)?.[0]).toBe("queue.clear");
  });

  test("volume at cliamp's top points to the system volume", async () => {
    expect(await music({ action: "volume", value: "9" }, ctx, fake().m)).toStartWith("cliamp is at its maximum (6 dB); louder: the system volume");
  });

  test("status when nothing runs does not start cliamp; with it, the state in a line", async () => {
    const off = fake(false);
    expect(await music({ action: "status" }, ctx, off.m)).toBe("cliamp is not running (play something to start it)");
    expect(off.started()).toBe(false);
    expect(await music({ action: "status" }, ctx, fake().m)).toBe("■ stopped: Lofi Stream (stream) · vol -10 dB · 2 in the playlist · next: http://synth");
  });

  test("status names no next song after the last one", async () => {
    const { m } = fake();
    await music({ action: "play", index: 1 }, ctx, m);
    expect(await music({ action: "status" }, ctx, m)).not.toContain("next:");
  });

  test("volume: a level, or up/down/+N as a change; nonsense is an error", async () => {
    const { m, ops } = fake();
    await music({ action: "volume", value: "-20" }, ctx, m);
    await music({ action: "volume", value: "down 5" }, ctx, m);
    await music({ action: "volume", value: "+2" }, ctx, m);
    expect(ops).toEqual([["volume", { value: -20 }], ["volume.adjust", { value: -5 }], ["volume.adjust", { value: 2 }]]);
    expect(await music({ action: "volume", value: "loud" }, ctx, m)).toStartWith("ERROR: music: volume needs");
  });

  test("radio: searches stations and plays the first; cliamp's own errors come back as tool errors", async () => {
    const { m, ops } = fake();
    expect(await music({ action: "radio", query: "jazz" }, ctx, m)).toStartWith("playing Jazz FM");
    expect(ops.at(-1)).toEqual(["url.load", { path: "http://jazz", play: true }]);
    expect(await music({ action: "eq", value: "Nope" }, ctx, m)).toBe('ERROR: music: unknown preset "Nope"');
    expect(await music({ action: "dance" }, ctx, m)).toStartWith("ERROR: music: action is one of");
  });

  test("the state line", () => {
    expect(describeState({ state: "playing", volume: -3, shuffle: true, repeat: "All", eq_preset: "Rock", total: 9, logical_track: { title: "Song" } })).toBe("▶ playing: Song · vol -3 dB · shuffle on · repeat all · eq Rock · 9 in the playlist");
  });
});
