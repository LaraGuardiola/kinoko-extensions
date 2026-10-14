// Talking to kinoko. Ctrl+Space opens the microphone (and Ctrl+Space again closes it); what you
// say that starts with "kinoko" is sent as your prompt ("Kinoko, mira por qué falla el test"), or
// while it works as a steer that goes in at once (the reply or the tools running are cut). "Kinoko" on its own: the next thing said, within a few seconds, is
// for kinoko without the name. The rule above the input says it is listening.
//
// ~/.kinoko/voice.json (see README):
//   { "stt": { "command": ["whisper-cli", "-m", "…/ggml-small-q5_1.bin", "-l", "es", "-ac", "{ac}",
//              "--prompt", "Kinoko", "-nt", "-np", "-f", "{wav}"] },
//     "wake": "kinoko", "record": ["pw-record", …] }
// or an OpenAI-compatible server: { "stt": { "http": "http://127.0.0.1:8092/v1/audio/transcriptions" } }

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Kinoko } from "../api.ts";
import { RATE, RECORD, openMic } from "./mic.ts";
import type { Mic } from "./mic.ts";
import { transcribe } from "./stt.ts";
import type { SttBackend } from "./stt.ts";
import { Vad } from "./vad.ts";
import { afterWake } from "./wake.ts";

export interface VoiceConfig {
  stt: SttBackend;
  /** The word that says it is for kinoko. */
  wake: string;
  /** The program that records: raw 16 kHz mono s16 on its stdout. */
  record: string[];
}

export const CONFIG_PATH = join(homedir(), ".kinoko", "voice.json");

/** How long after "kinoko" alone the next utterance needs no name. */
const FOLLOW_MS = 8_000;

/** "~/…" in a command is the home folder, as in a shell. */
const home = (arg: string): string => (arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg);

/** The config, or why there is none to use. */
export async function readConfig(path = CONFIG_PATH): Promise<VoiceConfig | string> {
  let raw: Partial<VoiceConfig>;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as Partial<VoiceConfig>;
  } catch {
    return `no ${path}: see the voice extension's README`;
  }
  const stt = raw.stt as Partial<{ command: unknown; http: unknown }> | undefined;
  const usable = stt !== undefined && ((Array.isArray(stt.command) && stt.command.length > 0) || typeof stt.http === "string");
  if (!usable) return `${path} needs "stt": a "command" or an "http" endpoint`;
  const backend = raw.stt as SttBackend;
  return { stt: "command" in backend ? { command: backend.command.map(home) } : backend, wake: raw.wake ?? "kinoko", record: (raw.record ?? RECORD).map(home) };
}

export interface Deps {
  config: () => Promise<VoiceConfig | string>;
  openMic: typeof openMic;
  transcribe: (stt: SttBackend, pcm: Int16Array, signal: AbortSignal) => Promise<string>;
  now: () => number;
}

export function install(k: Kinoko, deps: Deps): void {
  let mic: Mic | undefined;
  let stopper: AbortController | undefined; // the transcriptions in flight, cut when the mic closes
  let followUntil = 0;
  let opening = false; // Ctrl+Space pressed twice while the config is read: one microphone
  /** Utterances are transcribed one after the other, in the order they were said. */
  let queue = Promise.resolve();

  const listening = (): void => k.status(deps.now() < followUntil ? "● kinoko hears you" : "● listening");

  const close = (why?: string): void => {
    mic?.stop();
    mic = undefined;
    stopper?.abort();
    stopper = undefined;
    followUntil = 0;
    k.status(why === undefined ? undefined : `voice: ${why}`);
    if (why !== undefined) k.log(`voice: ${why}`);
  };

  const heard = async (config: VoiceConfig, pcm: Int16Array, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    // No "transcribing" word: every sound in the room is transcribed (to look for the name), and the
    // word would flicker; it stays "● listening" until something is for kinoko.
    let text: string;
    try {
      text = await deps.transcribe(config.stt, pcm, signal);
    } catch (e) {
      if (!signal.aborted) close(e instanceof Error ? e.message : String(e));
      return;
    }
    if (signal.aborted) return;
    const following = deps.now() < followUntil;
    const said = afterWake(text, config.wake) ?? (following ? text : undefined);
    if (said === "") {
      // The name alone: the next words are for kinoko; after a while, the name is needed again.
      followUntil = deps.now() + FOLLOW_MS;
      setTimeout(() => {
        if (mic && deps.now() >= followUntil) listening();
      }, FOLLOW_MS + 50).unref();
    } else if (said !== undefined) {
      followUntil = 0;
      // Said while kinoko works, it goes in at once: the reply or the tools running are cut (Alt+X's way).
      if (!k.send(said, { as: "steer_now" })) k.log(`voice: heard "${said}", but there is nowhere to send it`);
    }
    listening();
  };

  const open = async (): Promise<void> => {
    if (opening) return;
    opening = true;
    const config = await deps.config().finally(() => (opening = false));
    if (typeof config === "string") return close(config);
    const vad = new Vad({ rate: RATE });
    const own = new AbortController();
    stopper = own;
    mic = deps.openMic(
      config.record,
      (pcm) => {
        for (const event of vad.push(pcm)) {
          if (event.type === "end") queue = queue.then(() => heard(config, event.pcm, own.signal));
        }
      },
      (why) => {
        if (stopper === own) close(why ?? "the microphone stopped");
      },
    );
    listening();
  };

  k.registerKey(
    "ctrl-space",
    () => {
      if (mic) close();
      else return open();
      return undefined;
    },
    'Voice on/off: say "kinoko, …" and it is a prompt',
  );
  k.registerCommand("voice", async () => {
    if (mic) return `Listening: say "kinoko, …". Ctrl+Space closes the microphone.`;
    const config = await deps.config();
    return typeof config === "string" ? `Voice is not set up: ${config}.` : `Voice is off: Ctrl+Space opens the microphone.`;
  }, "talking to kinoko: is it listening, and how to set it up");
}

export default function voice(k: Kinoko): void {
  install(k, {
    config: () => readConfig(),
    openMic,
    transcribe: (stt, pcm, signal) => transcribe(stt, pcm, RATE, signal),
    now: () => Date.now(),
  });
}
