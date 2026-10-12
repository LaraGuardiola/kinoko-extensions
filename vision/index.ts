// Vision: lets the model look. Two read-only tools; the model needs to see images (a vision model,
// or the local one served with its mmproj).
//   view        a picture or a video from disk or a URL: any format ffmpeg decodes, scaled down;
//               a video comes as frames spread over it (or over a stretch of it).
//   screenshot  the screen, or the focused window.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Kinoko, ToolContext, ToolResult } from "../api.ts";
import { seconds, view } from "./media.ts";
import { screenshot } from "./screen.ts";

const SIZE = 1280;

function number(raw: unknown, fallback: number, min: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : fallback;
}

/** A path from the model: ~ expanded, relative to the working directory; URLs as they are. */
export function resolve(path: string, cwd: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const home = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(home) ? home : join(cwd, home);
}

const failed = (answer: ToolResult | string): ToolResult | string => (typeof answer === "string" && !answer.startsWith("ERROR:") ? `ERROR: view: ${answer}` : answer);

export default function (k: Kinoko): void {
  k.registerTool({
    name: "view",
    description:
      "Look at an image or a video (a file path or an http(s) URL): photos, screenshots, diagrams, any format (HEIC, AVIF, WebP...). A video comes as frames spread over it, or over from..to. Use it instead of read for pictures.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path or http(s) URL" },
        size: { type: "number", description: `longest side in pixels (default ${SIZE}; more for small text, at most 2048)` },
        frames: { type: "number", description: "video: how many frames (default 6, at most 16)" },
        from: { type: "string", description: 'video: start, seconds or "m:ss" (default the start)' },
        to: { type: "string", description: 'video: end, seconds or "m:ss" (default the end)' },
      },
      required: ["path"],
    },
    readOnly: true,
    run: async (args: { path?: unknown; size?: unknown; frames?: unknown; from?: unknown; to?: unknown }, ctx: ToolContext) => {
      if (typeof args.path !== "string" || args.path.trim() === "") return "ERROR: view: missing path (string)";
      const input = resolve(args.path.trim(), ctx.cwd);
      if (!/^https?:/i.test(input) && !(await Bun.file(input).exists())) return `ERROR: view: no file at ${input}`;
      const opts = { size: number(args.size, SIZE, 64, 2048), frames: number(args.frames, 6, 1, 16), from: seconds(args.from), to: seconds(args.to) };
      return failed(await view(input, args.path.trim(), opts, ctx.signal));
    },
  });

  // Windows has nothing it can capture with: the model is not offered it there.
  if (process.platform === "win32") return;
  k.registerTool({
    name: "screenshot",
    description: "Take a screenshot to look at: the whole screen, or the focused window (usually the terminal kinoko runs in).",
    schema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["screen", "window"], description: "screen (default) or window" },
        size: { type: "number", description: `longest side in pixels (default ${SIZE}, at most 2048)` },
      },
    },
    readOnly: true,
    run: async (args: { target?: unknown; size?: unknown }, ctx: ToolContext) =>
      screenshot(args.target === "window" ? "window" : "screen", number(args.size, SIZE, 64, 2048), ctx.signal),
  });
}
