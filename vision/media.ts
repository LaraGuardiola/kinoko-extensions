// Pictures and videos as images a model can read, through ffmpeg: any format it decodes (HEIC,
// AVIF, WebP, TIFF, BMP, a phone's video...), scaled down to what the APIs take, as PNG (drawings,
// screenshots: sharp text) or JPEG (photos, frames: small). A video gives frames spread over it.
// Without ffmpeg, a PNG, JPEG, GIF or WebP small enough still goes as it is.

import type { Image, ToolResult } from "../api.ts";

/** Over this the APIs refuse an image (Anthropic: 5 MB of base64). */
export const MAX_BYTES = 3_750_000;
/** A run of ffmpeg that takes longer has hung (a stalled URL): Esc cuts it sooner. */
const TIMEOUT_MS = 60_000;
const RAW: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** Sources whose pixels are sharp (drawings, screenshots, UI): kept lossless. */
const SHARP = /^(png|bmp|gif|tiff|ppm|pgm|qoi|ico|svg)/;

export interface Exec {
  code: number;
  out: Uint8Array;
  err: string;
}

/** Runs a command, its stdin fed from `input`; killed on abort or after TIMEOUT_MS. */
export async function exec(cmd: string[], signal: AbortSignal, input?: Uint8Array): Promise<Exec> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err: err.trim() };
  } catch (e) {
    return { code: 127, out: new Uint8Array(), err: e instanceof Error ? e.message : String(e) }; // not installed
  }
}

export interface Probe {
  width: number;
  height: number;
  codec: string;
  /** Seconds, for a video (an animated GIF counts). */
  duration?: number;
}

/** What ffprobe sees in the file or URL: its first picture stream, and how long it runs. */
export async function probe(input: string, signal: AbortSignal): Promise<Probe | string> {
  const res = await exec(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration,format_name", "-of", "json", input], signal);
  if (res.code === 127) return "ffprobe is not installed (it comes with ffmpeg)";
  if (res.code !== 0) return res.err.split("\n").at(-1) || `ffprobe could not read ${input}`;
  const data = JSON.parse(new TextDecoder().decode(res.out)) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const stream = data.streams?.[0];
  if (stream === undefined) return `no picture in ${input}`;
  const format = String(data.format?.format_name ?? "");
  const duration = Number(data.format?.duration);
  const still = /image2|_pipe|^png|^jpeg/.test(format) || !(duration > 0.3);
  return { width: Number(stream.width) || 0, height: Number(stream.height) || 0, codec: String(stream.codec_name ?? "?"), duration: still ? undefined : duration };
}

/** One picture, at `at` seconds for a video, at most `size` pixels on its long side. */
export async function frame(input: string, opts: { size: number; at?: number; png: boolean }, signal: AbortSignal, stdin?: Uint8Array): Promise<Image | string> {
  let size = opts.size;
  for (let attempt = 0; attempt < 3; attempt++) {
    const codec = opts.png ? ["-c:v", "png"] : ["-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p"];
    // oxlint-disable-next-line no-await-in-loop -- a retry, smaller, only when the last one was too big
    const res = await exec(
      [
        "ffmpeg", "-v", "error", "-nostdin", ...(opts.at === undefined ? [] : ["-ss", opts.at.toFixed(2)]), "-i", stdin ? "pipe:0" : input,
        "-frames:v", "1", "-vf", `scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`, ...codec, "-f", "image2pipe", "-",
      ],
      signal,
      stdin,
    );
    if (res.code === 127) return "ffmpeg is not installed";
    if (res.code !== 0 || res.out.length === 0) return res.err.split("\n").at(-1) || `ffmpeg could not read ${input}`;
    if (res.out.length <= MAX_BYTES) return { mime: opts.png ? "image/png" : "image/jpeg", data: Buffer.from(res.out).toString("base64") };
    size = Math.floor(size * 0.7); // too big for the APIs: smaller
  }
  return `${input} stays over ${MAX_BYTES / 1_000_000} MB even scaled down`;
}

/** Width and height of an encoded PNG or JPEG, read from its header. */
export function dimensions(image: Image): [number, number] {
  const b = Buffer.from(image.data, "base64");
  if (image.mime === "image/png") return [b.readUInt32BE(16), b.readUInt32BE(20)];
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) return [0, 0];
    const marker = b[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
}

/** "1:23.4" for 83.4 seconds. */
export function clock(total: number): string {
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const h = Math.floor(m / 60);
  const sec = `${s < 10 ? "0" : ""}${s.toFixed(1)}`;
  return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Seconds from 12, "12.5", "1:30" or "1:02:03". */
export function seconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== "string" || !/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(value.trim())) return undefined;
  return value.trim().split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

const kb = (image: Image): string => `${Math.round((image.data.length * 0.75) / 1000)} KB`;

export interface ViewOptions {
  /** Longest side, in pixels. */
  size: number;
  /** For a video: how many frames, and the stretch they are spread over (seconds). */
  frames: number;
  from?: number;
  to?: number;
}

/** A picture, or a video's frames, ready for the model; a string says why not. */
export async function view(input: string, label: string, opts: ViewOptions, signal: AbortSignal): Promise<ToolResult | string> {
  const info = await probe(input, signal);
  if (typeof info === "string") return raw(input, label, info);
  if (info.duration === undefined) {
    const image = await frame(input, { size: opts.size, png: SHARP.test(info.codec) }, signal);
    if (typeof image === "string") return image;
    const [w, h] = dimensions(image);
    return { text: `${label}: ${info.width}×${info.height} ${info.codec}, sent as ${w}×${h} ${image.mime.slice(6).toUpperCase()} (${kb(image)})`, images: [image] };
  }
  const from = Math.min(opts.from ?? 0, info.duration);
  const to = Math.min(Math.max(opts.to ?? info.duration, from), info.duration);
  const count = to - from < 0.5 ? 1 : opts.frames;
  const times = Array.from({ length: count }, (_, i) => from + ((i + 0.5) * (to - from)) / count);
  const size = Math.min(opts.size, 768); // many frames: each smaller
  const images: Image[] = [];
  for (let i = 0; i < times.length; i += 4) {
    // oxlint-disable-next-line no-await-in-loop -- four ffmpegs at a time, not sixteen
    const batch = await Promise.all(times.slice(i, i + 4).map((at) => frame(input, { size, at, png: false }, signal)));
    for (const one of batch) {
      if (typeof one === "string") return one;
      images.push(one);
    }
  }
  const [w, h] = images[0] ? dimensions(images[0]) : [0, 0];
  const list = times.map((t, i) => `  ${i + 1}. ${clock(t)}`).join("\n");
  return { text: `${label}: video ${clock(info.duration)}, ${info.width}×${info.height} ${info.codec}; ${count} frame${count === 1 ? "" : "s"} at ${w}×${h}, in order:\n${list}`, images };
}

/** No ffmpeg (or it failed): a common format small enough goes as it is. */
async function raw(input: string, label: string, why: string): Promise<ToolResult | string> {
  const mime = RAW[/\.(\w+)$/.exec(input)?.[1]?.toLowerCase() ?? ""];
  const file = Bun.file(input);
  if (mime === undefined || /^https?:/.test(input) || !(await file.exists())) return `ERROR: view: ${why}`;
  if (file.size > MAX_BYTES) return `ERROR: view: ${why}; ${label} is too big to send as it is (${Math.round(file.size / 1_000_000)} MB)`;
  const image = { mime, data: Buffer.from(await file.bytes()).toString("base64") };
  return { text: `${label}: sent as it is (${why})`, images: [image] };
}
