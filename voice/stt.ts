// Speech to text, two ways: a program run once an utterance (whisper.cpp's whisper-cli: nothing to
// keep running, a small model loads in a blink), or an OpenAI-compatible server
// (/v1/audio/transcriptions: whisper.cpp's server, speaches, a cloud API).

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wav } from "./wav.ts";

/**
 * `command`: argv, with `{wav}` the utterance's file and `{ac}` whisper's audio context sized to it
 * (whisper otherwise encodes 30 s of audio for a 2 s phrase: ten times slower on a CPU).
 * `http`: the endpoint, with an optional key, model and language.
 */
export type SttBackend = { command: string[] } | { http: string; key?: string; model?: string; language?: string };

/** whisper's audio context for `seconds` of audio: 50 per second (1500 is its full 30 s), a second spare. */
export function audioContext(seconds: number): number {
  return Math.min(1500, Math.ceil((seconds + 1) * 50));
}

let files = 0;

export async function transcribe(backend: SttBackend, pcm: Int16Array, rate: number, signal: AbortSignal): Promise<string> {
  const audio = wav(pcm, rate);
  if ("http" in backend) {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "utterance.wav");
    form.append("model", backend.model ?? "whisper-1");
    if (backend.language) form.append("language", backend.language);
    form.append("response_format", "json");
    const res = await fetch(backend.http, { method: "POST", body: form, signal, headers: backend.key ? { authorization: `Bearer ${backend.key}` } : {} });
    if (!res.ok) throw new Error(`${backend.http} answered ${res.status}`);
    return clean(((await res.json()) as { text?: string }).text ?? "");
  }
  const path = join(tmpdir(), `kinoko-voice-${process.pid}-${++files}.wav`);
  await Bun.write(path, audio);
  try {
    const ac = String(audioContext(pcm.length / rate));
    const argv = backend.command.map((arg) => arg.replaceAll("{wav}", path).replaceAll("{ac}", ac));
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${argv[0]} failed (${code}): ${err.trim().split("\n").at(-1) ?? ""}`);
    return clean(out);
  } finally {
    await rm(path, { force: true });
  }
}

/** One line of text: whisper's timestamps and its sound notes ("[BLANK_AUDIO]", "(música)") out. */
export function clean(text: string): string {
  return text
    .replace(/^\s*\[\d[\d:.]*\s*-->\s*[\d:.]+\]/gm, "")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
