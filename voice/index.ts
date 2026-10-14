// Talking with kinoko. Ctrl+Space turns voice mode on (and off again): kinoko listens, and reads
// its replies aloud as it writes them. What you say that starts with "kinoko" is your prompt
// ("Kinoko, mira por qué falla el test"), or, while it works, a steer that goes in at once (the
// reply or the tools running are cut). "Kinoko" on its own: the next thing said, within a few
// seconds, is for kinoko without the name. Esc, or talking to it, stops its voice. The rule above
// the input says it is listening.
//
// ~/.kinoko/voice.json (see README):
//   { "stt": { "command": ["whisper-cli", "-m", "…/ggml-small-q5_1.bin", "-l", "es", "-ac", "{ac}",
//              "--prompt", "Kinoko", "-nt", "-np", "-f", "{wav}"] },
//     "tts": { "http": "http://127.0.0.1:8091/v1/audio/speech", "voice": "wheatley", "language": "Spanish" },
//     "wake": "kinoko", "record": ["pw-record", …] }
// or an OpenAI-compatible server: { "stt": { "http": "http://127.0.0.1:8092/v1/audio/transcriptions" } }

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Kinoko } from "../api.ts";
import { RATE, RECORD, openMic } from "./mic.ts";
import type { Mic } from "./mic.ts";
import { Sentences } from "./sentences.ts";
import { Speaker, openPlayer, registerVoice, synth } from "./speaker.ts";
import type { TtsBackend } from "./speaker.ts";
import { transcribe } from "./stt.ts";
import type { SttBackend } from "./stt.ts";
import { Vad } from "./vad.ts";
import { afterWake, isEcho } from "./wake.ts";

export interface VoiceConfig {
  stt: SttBackend;
  /** The word that says it is for kinoko. */
  wake: string;
  /** The program that records: raw 16 kHz mono s16 on its stdout. */
  record: string[];
  /** How replies are read aloud; without it kinoko only listens. */
  tts?: TtsBackend;
}

/** What install needs of a Speaker (tests pass a fake). */
export type Voice = Pick<Speaker, "say" | "end" | "stop" | "speaking" | "recent">;

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
  const tts = raw.tts && "command" in raw.tts ? { ...raw.tts, command: raw.tts.command.map(home) } : raw.tts;
  return { stt: "command" in backend ? { command: backend.command.map(home) } : backend, wake: raw.wake ?? "kinoko", record: (raw.record ?? RECORD).map(home), ...(tts ? { tts } : {}) };
}

export interface Deps {
  config: () => Promise<VoiceConfig | string>;
  openMic: typeof openMic;
  transcribe: (stt: SttBackend, pcm: Int16Array, signal: AbortSignal) => Promise<string>;
  /** A voice that speaks through `tts`; `failed` when it cannot. */
  speaker: (tts: TtsBackend, failed: (why: string) => void) => Voice;
  now: () => number;
}

export function install(k: Kinoko, deps: Deps): void {
  let mic: Mic | undefined;
  let stopper: AbortController | undefined; // the transcriptions in flight, cut when the mic closes
  let followUntil = 0;
  let opening = false; // Ctrl+Space pressed twice while the config is read: one microphone
  /** Utterances are transcribed one after the other, in the order they were said. */
  let queue = Promise.resolve();
  let speaker: Voice | undefined; // while voice mode is on, and a "tts" is set up
  let quiet = false; // /voice quiet: listening only
  let voiceName: string | undefined; // /voice <name>, over the config's
  const sentences = new Sentences();
  /** The last things heard, for /voice: what whisper wrote, and what became of it. */
  let heardLately: string[] = [];
  const remember = (text: string, what: string): void => {
    if (text !== "") heardLately = [...heardLately, `  "${text}" → ${what}`].slice(-5);
  };

  const hush = (): void => {
    speaker?.stop();
    sentences.reset();
  };

  // The reply, read aloud as it is written: sentence by sentence; a new run starts from silence.
  k.on("agent_event", (e) => {
    if (speaker === undefined || quiet) return;
    if (e.type === "run_start") hush();
    else if (e.type === "message_delta") for (const s of sentences.push(e.delta)) speaker.say(s);
    else if (e.type === "message_end") {
      for (const s of sentences.flush()) speaker.say(s);
      speaker.end();
    } else if (e.type === "run_end" && e.reason === "aborted") hush();
  });
  k.on("interrupt", hush);

  const listening = (): void => k.status(deps.now() < followUntil ? "● kinoko hears you" : "● listening");

  const close = (why?: string): void => {
    hush();
    speaker = undefined;
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
    // Its own voice, heard through the microphone, is not the user.
    if (speaker && said !== undefined && isEcho(said, speaker.recent)) {
      remember(text, "its own voice: dropped");
      return listening();
    }
    remember(text, said === undefined ? 'not for kinoko (no "kinoko" starting a sentence)' : said === "" ? "the name: listening for what follows" : "sent");
    if (said === "") {
      // The name alone: the next words are for kinoko; after a while, the name is needed again.
      followUntil = deps.now() + FOLLOW_MS;
      setTimeout(() => {
        if (mic && deps.now() >= followUntil) listening();
      }, FOLLOW_MS + 50).unref();
    } else if (said !== undefined) {
      followUntil = 0;
      hush(); // talked to, it stops talking
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
    // "/voice none": the model's own voice, no clone.
    const tts = config.tts && voiceName !== undefined ? { ...config.tts, voice: voiceName === "none" ? undefined : voiceName } : config.tts;
    speaker = tts ? deps.speaker(tts, (why) => k.log(`voice: could not speak: ${why}`)) : undefined;
    const vad = new Vad({ rate: RATE });
    const own = new AbortController();
    stopper = own;
    mic = deps.openMic(
      config.record,
      (pcm) => {
        for (const event of vad.push(pcm)) {
          // kinoko keeps talking over other voices in the room: it stops only for a "kinoko, …".
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
    'Voice on/off: kinoko listens ("kinoko, …") and talks',
  );
  k.registerCommand(
    "voice",
    async (args) => {
      const word = args.trim();
      if (word === "quiet" || word === "talk") {
        quiet = word === "quiet";
        if (quiet) hush();
        return quiet ? "Kinoko listens but does not talk. /voice talk to hear it again." : "Kinoko talks again (in voice mode).";
      }
      if (word !== "") {
        voiceName = word;
        return word === "none"
          ? "Voice: the model's own (no clone), the next time voice mode is turned on."
          : `Voice: ${word} (from ~/.kinoko/voices/${word}.*). It speaks with it the next time voice mode is turned on.`;
      }
      const config = await deps.config();
      if (typeof config === "string") return `Voice is not set up: ${config}.`;
      const talks = config.tts ? (quiet ? "it does not talk (/voice talk)" : `it talks as ${voiceName ?? config.tts.voice ?? "the default voice"} (/voice quiet)`) : 'no "tts" in voice.json: it only listens';
      const lately = heardLately.length > 0 ? `\nHeard lately:\n${heardLately.join("\n")}` : "";
      return (mic ? `Listening: say "kinoko, …"; ${talks}. Ctrl+Space turns it off.` : `Voice is off: Ctrl+Space turns it on; ${talks}.`) + lately;
    },
    "talking with kinoko: on or off, the voice (/voice <name>, /voice none), quiet or talk",
  );
}

export default function voice(k: Kinoko): void {
  install(k, {
    config: () => readConfig(),
    openMic,
    transcribe: (stt, pcm, signal) => transcribe(stt, pcm, RATE, signal),
    speaker: (tts, failed) =>
      new Speaker({
        synth: synth(tts),
        player: () => openPlayer(tts.rate ?? 24_000),
        prepare: "http" in tts && tts.voice ? async () => void (await registerVoice(tts.http, tts.voice ?? "")) : undefined,
        failed,
      }),
    now: () => Date.now(),
  });
}
