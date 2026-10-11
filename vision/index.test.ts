import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolResult } from "../api.ts";
import { Bus } from "../testing/bus.ts";
import install, { resolve } from "./index.ts";
import { clock, dimensions, seconds, view } from "./media.ts";
import { screenshot } from "./screen.ts";

const signal = new AbortController().signal;
const hasFfmpeg = Bun.spawnSync(["sh", "-c", "command -v ffmpeg && command -v ffprobe"]).exitCode === 0;
const dir = mkdtempSync(join(tmpdir(), "kinoko-vision-"));
const opts = { size: 1280, frames: 6 };

function make(name: string, args: string[]): string {
  const path = join(dir, name);
  Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args, path]);
  return path;
}

beforeAll(() => {
  if (!hasFfmpeg) return;
  make("drawing.png", ["-f", "lavfi", "-i", "testsrc2=size=3000x1500", "-frames:v", "1"]);
  make("photo.jpg", ["-f", "lavfi", "-i", "testsrc2=size=800x600", "-frames:v", "1"]);
  make("clip.mp4", ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=10", "-pix_fmt", "yuv420p"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ok = (r: ToolResult | string): ToolResult => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("vision: helpers", () => {
  test("paths: ~ and relative ones resolved, URLs as they are", () => {
    expect(resolve("a.png", "/work")).toBe("/work/a.png");
    expect(resolve("/abs/a.png", "/work")).toBe("/abs/a.png");
    expect(resolve("~/a.png", "/work")).toEndWith("/a.png");
    expect(resolve("https://x.dev/a.png", "/work")).toBe("https://x.dev/a.png");
  });

  test("times: seconds or m:ss in, m:ss.s out", () => {
    expect(seconds(12)).toBe(12);
    expect(seconds("1:30")).toBe(90);
    expect(seconds("1:02:03.5")).toBe(3723.5);
    expect(seconds("soon")).toBeUndefined();
    expect(clock(83.44)).toBe("1:23.4");
    expect(clock(5)).toBe("0:05.0");
    expect(clock(3725)).toBe("1:02:05.0");
  });

  test("registers view and screenshot, both read-only", () => {
    const bus = new Bus();
    install(bus);
    expect(bus.tools().map((t: Tool) => [t.name, t.readOnly])).toEqual([["view", true], ["screenshot", true]]);
  });

  test("bad arguments and missing files are tool errors", async () => {
    const bus = new Bus();
    install(bus);
    const tool = bus.tools()[0];
    expect(await tool?.run({}, { signal, cwd: dir })).toBe("ERROR: view: missing path (string)");
    expect(await tool?.run({ path: "nope.png" }, { signal, cwd: dir })).toBe(`ERROR: view: no file at ${join(dir, "nope.png")}`);
  });

  test("no display at all: screenshot says so", async () => {
    if (process.platform === "darwin") return;
    expect(await screenshot("screen", 800, signal, {})).toBe("ERROR: screenshot: no screen to capture (no Wayland, X11 or macOS display)");
  });
});

describe.skipIf(!hasFfmpeg)("vision: with ffmpeg", () => {
  test("a drawing stays PNG (sharp text), scaled to the size asked", async () => {
    const r = ok(await view(join(dir, "drawing.png"), "drawing.png", { ...opts, size: 1000 }, signal));
    expect(r.images?.[0]?.mime).toBe("image/png");
    expect(dimensions(r.images?.[0] ?? { mime: "", data: "" })).toEqual([1000, 500]);
    expect(r.text).toBe(`drawing.png: 3000×1500 png, sent as 1000×500 PNG (${Math.round(((r.images?.[0]?.data.length ?? 0) * 0.75) / 1000)} KB)`);
  });

  test("a photo goes as JPEG, never scaled up", async () => {
    const r = ok(await view(join(dir, "photo.jpg"), "photo.jpg", opts, signal));
    expect(r.images?.[0]?.mime).toBe("image/jpeg");
    expect(dimensions(r.images?.[0] ?? { mime: "", data: "" })).toEqual([800, 600]);
  });

  test("a video: frames spread over it, in order, with their times", async () => {
    const r = ok(await view(join(dir, "clip.mp4"), "clip.mp4", { ...opts, frames: 4 }, signal));
    expect(r.images).toHaveLength(4);
    expect(r.text).toStartWith("clip.mp4: video 0:10.0, 640×360 h264; 4 frames at 640×360, in order:");
    expect(r.text).toContain("  1. 0:01.3\n  2. 0:03.8\n  3. 0:06.3\n  4. 0:08.8");
  });

  test("a stretch of a video: from..to", async () => {
    const r = ok(await view(join(dir, "clip.mp4"), "clip.mp4", { ...opts, frames: 2, from: 2, to: 4 }, signal));
    expect(r.text).toContain("  1. 0:02.5\n  2. 0:03.5");
  });

  test("not a picture: a tool error with ffprobe's reason", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    expect(await view(join(dir, "notes.txt"), "notes.txt", opts, signal)).toStartWith("ERROR: view:");
  });

  test("Esc stops it", async () => {
    const cut = new AbortController();
    cut.abort();
    expect(typeof (await view(join(dir, "clip.mp4"), "clip.mp4", opts, cut.signal))).toBe("string");
  });
});
