// Screenshots: the screen, or the focused window (often kinoko's own terminal: the model can look
// at what it just drew). Wayland with grim (Hyprland knows which monitor and window has focus),
// X11 with ImageMagick's import, macOS with screencapture. Scaled like any picture (media.ts).

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../api.ts";
import { dimensions, exec, frame, MAX_BYTES } from "./media.ts";

type Env = Record<string, string | undefined>;

/** The command that writes a PNG of `target` to stdout (or to a file, on macOS), and what it
 *  ended up capturing. */
async function command(target: "screen" | "window", env: Env, signal: AbortSignal): Promise<{ cmd: string[]; file?: string; what: string } | string> {
  if (process.platform === "darwin") {
    const file = join(tmpdir(), `kinoko-shot-${process.pid}.png`);
    return { cmd: ["screencapture", "-x", "-t", "png", file], file, what: "the screen" };
  }
  if (env.WAYLAND_DISPLAY) {
    if (env.HYPRLAND_INSTANCE_SIGNATURE) {
      const ask = async (what: string): Promise<unknown> => {
        const res = await exec(["hyprctl", what, "-j"], signal);
        return res.code === 0 ? JSON.parse(new TextDecoder().decode(res.out)) : undefined;
      };
      if (target === "window") {
        const win = (await ask("activewindow")) as { at?: [number, number]; size?: [number, number]; title?: string } | undefined;
        if (win?.at && win.size) return { cmd: ["grim", "-g", `${win.at[0]},${win.at[1]} ${win.size[0]}x${win.size[1]}`, "-"], what: `the window "${win.title ?? "?"}"` };
      }
      const monitors = (await ask("monitors")) as Array<{ name: string; focused: boolean }> | undefined;
      const focused = monitors?.find((m) => m.focused)?.name;
      if (focused) return { cmd: ["grim", "-o", focused, "-"], what: `the screen (${focused})${target === "window" ? ", no focused window" : ""}` };
    }
    return { cmd: ["grim", "-"], what: "the screen" };
  }
  if (env.DISPLAY) return { cmd: ["import", "-window", "root", "png:-"], what: "the screen" };
  return "no screen to capture (no Wayland, X11 or macOS display)";
}

export async function screenshot(target: "screen" | "window", size: number, signal: AbortSignal, env: Env = process.env): Promise<ToolResult | string> {
  const how = await command(target, env, signal);
  if (typeof how === "string") return `ERROR: screenshot: ${how}`;
  const res = await exec(how.cmd, signal);
  if (res.code === 127) return `ERROR: screenshot: ${how.cmd[0]} is not installed`;
  let png = res.out;
  if (how.file !== undefined) {
    const file = Bun.file(how.file);
    png = (await file.exists()) ? await file.bytes() : new Uint8Array();
    await file.delete().catch(() => undefined);
  }
  if (res.code !== 0 || png.length === 0) return `ERROR: screenshot: ${res.err.split("\n").at(-1) || `${how.cmd[0]} failed`}`;
  const full = { mime: "image/png", data: Buffer.from(png).toString("base64") };
  const [w, h] = dimensions(full);
  // Lossless, for the text on it; scaled by ffmpeg, or as it is when ffmpeg is missing and it fits.
  const image = await frame("screenshot", { size, png: true }, signal, png);
  if (typeof image === "string") {
    if (png.length <= MAX_BYTES && Math.max(w, h) <= 2048) return { text: `screenshot of ${how.what}: ${w}×${h}, sent as it is (${image})`, images: [full] };
    return `ERROR: screenshot: ${image}`;
  }
  const [sw, sh] = dimensions(image);
  return { text: `screenshot of ${how.what}: ${w}×${h}, sent as ${sw}×${sh} PNG`, images: [image] };
}
