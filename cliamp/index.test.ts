import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../testing/bus.ts";
import install, { describe as describeState, findSongs, music } from "./index.ts";
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
  const state = { state: "stopped", volume: -10, total: 2, logical_track: { title: "Lofi Stream", stream: true } };
  const m: Music = {
    library,
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
      if (op === "queue") state.total++;
      if (op === "queue.play") state.state = "playing";
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
    expect(ops).toEqual([["queue", { path: join(library, "Fox Stevenson/Glue Gun.mp3") }], ["queue.play", { index: 2 }]]);
    expect(out).toStartWith("playing Glue Gun.mp3\n▶ playing:");
  });

  test("status when nothing runs does not start cliamp; with it, the state in a line", async () => {
    const off = fake(false);
    expect(await music({ action: "status" }, ctx, off.m)).toBe("cliamp is not running (play something to start it)");
    expect(off.started()).toBe(false);
    expect(await music({ action: "status" }, ctx, fake().m)).toBe("■ stopped: Lofi Stream (stream) · vol -10 dB · 2 in the playlist");
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
