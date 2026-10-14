// Speaking: each sentence goes to the text-to-speech backend as soon as it is whole, and its audio
// streams into one player for the whole reply. The backend makes speech several times faster than
// it is heard, so while one sentence plays the next is already made: no gaps. stop() is silence at
// once: the requests in flight are aborted and the player killed.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `http`: an OpenAI-compatible /v1/audio/speech, asked for raw 16-bit PCM ("pcm") streamed as it is
 * made. `command`: a program that reads the text on stdin and writes raw 16-bit mono PCM to stdout.
 */
export type TtsBackend = ({ http: string; key?: string } | { command: string[] }) & { voice?: string; language?: string; rate?: number };

export const VOICES = join(homedir(), ".kinoko", "voices");
const PLAY = (rate: number): string[] => ["pw-play", "--raw", "--rate", String(rate), "--channels", "1", "--format", "s16", "-"];

/** The audio of one sentence, as it is made. */
export type Synth = (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;

export interface Player {
  write(chunk: Uint8Array): void;
  /** How loud from now on: 1 as made, less to make room for the user's voice. */
  gain(g: number): void;
  /** No more audio: resolves once what was written has been heard. */
  end(): Promise<void>;
  kill(): void;
}

/** How far ahead of what is heard the player is fed: a change of volume is heard this soon. */
const LEAD_S = 0.25;

/** 16-bit samples made `g` times as loud. */
export function scaled(chunk: Uint8Array, g: number): Uint8Array {
  if (g === 1) return chunk;
  const out = new Uint8Array(chunk);
  const view = new DataView(out.buffer);
  for (let i = 0; i + 1 < out.length; i += 2) view.setInt16(i, Math.round(view.getInt16(i, true) * g), true);
  return out;
}

/**
 * pw-play reading raw PCM on its stdin, fed in real time: never more than a quarter of a second
 * ahead (the speech is made several times faster than it is heard, so the rest waits here), so a
 * lower volume, or silence, is heard at once.
 */
export function openPlayer(rate: number, argv = PLAY(rate)): Player {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const waiting: Uint8Array[] = [];
  let odd: number | undefined; // a sample split between two chunks
  let loud = 1;
  let ended = false;
  const killed = new AbortController();
  const bytesPerSecond = rate * 2;
  const pump = (async () => {
    let start = 0;
    let sent = 0;
    while (!killed.signal.aborted) {
      const chunk = waiting.shift();
      if (chunk === undefined) {
        if (ended) break;
        // oxlint-disable-next-line no-await-in-loop -- waiting for more speech
        await Bun.sleep(15);
        continue;
      }
      const now = performance.now() / 1000;
      if (start === 0 || sent / bytesPerSecond - (now - start) < 0) {
        start = now; // nothing left playing: count from here (a gap between sentences)
        sent = 0;
      }
      const ahead = sent / bytesPerSecond - (now - start);
      // oxlint-disable-next-line no-await-in-loop -- feeding in real time is the point
      if (ahead > LEAD_S) await Bun.sleep((ahead - LEAD_S) * 1000);
      if (killed.signal.aborted) break;
      const audio = scaled(chunk, loud);
      proc.stdin.write(audio);
      sent += audio.length;
    }
  })();
  return {
    write: (chunk) => {
      const bytes = odd === undefined ? chunk : Uint8Array.of(odd, ...chunk);
      odd = bytes.length % 2 === 1 ? bytes.at(-1) : undefined;
      // Small pieces, so the volume can change within a sentence.
      const whole = bytes.length - (bytes.length % 2);
      const piece = Math.max(2, Math.round(bytesPerSecond * 0.05) & ~1);
      for (let i = 0; i < whole; i += piece) waiting.push(bytes.subarray(i, Math.min(whole, i + piece)));
    },
    gain: (g) => {
      loud = g;
    },
    end: async () => {
      ended = true;
      await pump;
      await proc.stdin.end();
      await proc.exited;
    },
    kill: () => {
      killed.abort();
      waiting.length = 0;
      proc.kill();
    },
  };
}

/** A sentence's audio from the backend. */
export function synth(backend: TtsBackend): Synth {
  return async function* (text, signal) {
    if ("http" in backend) {
      const body = { model: "tts", input: text, voice: backend.voice ?? "default", language: backend.language, response_format: "pcm" };
      const res = await fetch(backend.http, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok || res.body === null) throw new Error(`${backend.http} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      yield* res.body;
      return;
    }
    const proc = Bun.spawn(backend.command, { stdin: "pipe", stdout: "pipe", stderr: "ignore", signal });
    await proc.stdin.write(text);
    await proc.stdin.end();
    yield* proc.stdout;
  };
}

/**
 * Teaches the server a cloned voice from ~/.kinoko/voices: `<name>.txt` (what the clip says) with
 * `<name>.spk` and `<name>.rvq` (the clip encoded ahead, qwentts.cpp's qwen-codec: nothing for the
 * GPU to encode) or `<name>.wav`. qwentts.cpp's POST /v1/audio/voices; false when there is no such
 * voice here or the server has no such endpoint.
 */
export async function registerVoice(speechUrl: string, name: string, dir = VOICES, signal = AbortSignal.timeout(30_000)): Promise<boolean> {
  const file = (ext: string): Promise<Buffer | undefined> => readFile(join(dir, `${name}${ext}`)).catch(() => undefined);
  const [txt, spk, rvq, wav] = await Promise.all([file(".txt"), file(".spk"), file(".rvq"), file(".wav")]);
  const audio = spk && rvq ? { spk_b64: spk.toString("base64"), rvq_b64: rvq.toString("base64") } : wav ? { wav_b64: wav.toString("base64") } : undefined;
  if (audio === undefined) return false;
  const url = speechUrl.replace(/\/speech$/, "/voices");
  const res = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ref_text: txt?.toString("utf8").trim() ?? "", ...audio }) }).catch(() => undefined);
  return res?.ok === true;
}

/** How loud kinoko goes on while the user may be talking to it. */
const DUCKED = 0.2;

export interface SpeakerDeps {
  synth: Synth;
  player: () => Player;
  /** Before the first sentence (and after a failure): the voice taught to the server. */
  prepare?: () => Promise<void>;
  failed: (why: string) => void;
}

export class Speaker {
  #deps: SpeakerDeps;
  #queue: string[] = [];
  #stopper: AbortController | undefined;
  #player: Player | undefined;
  #working: Promise<void> | undefined;
  #ended = false;
  #prepared = false;
  #gain = 1;
  /** What was said lately, so the microphone can tell kinoko's own voice from the user's. */
  recent: string[] = [];

  constructor(deps: SpeakerDeps) {
    this.#deps = deps;
  }

  get speaking(): boolean {
    return this.#working !== undefined;
  }

  /** One more sentence of the reply being spoken. */
  say(sentence: string): void {
    this.#queue.push(sentence);
    this.#ended = false;
    this.#working ??= this.#work();
  }

  /** The reply is over: the player finishes what it has and closes. */
  end(): void {
    this.#ended = true;
  }

  /** Quieter while the user may be talking (`on`), or as loud as made again. */
  duck(on: boolean): void {
    this.#gain = on ? DUCKED : 1;
    this.#player?.gain(this.#gain);
  }

  /** Silence, now. */
  stop(): void {
    this.#queue = [];
    this.#stopper?.abort();
    this.#player?.kill();
  }

  async #work(): Promise<void> {
    const stopper = new AbortController();
    this.#stopper = stopper;
    try {
      if (!this.#prepared && this.#deps.prepare) await this.#deps.prepare();
      this.#prepared = true;
      this.#player = this.#deps.player();
      this.#player.gain(this.#gain);
      while (!stopper.signal.aborted) {
        const sentence = this.#queue.shift();
        if (sentence === undefined) {
          if (this.#ended) break;
          // oxlint-disable-next-line no-await-in-loop -- waiting for the model to write the next sentence
          await new Promise((r) => setTimeout(r, 30));
          continue;
        }
        this.recent = [...this.recent, sentence].slice(-6);
        // oxlint-disable-next-line no-await-in-loop -- sentences are spoken in order
        for await (const chunk of this.#deps.synth(sentence, stopper.signal)) this.#player.write(chunk);
      }
      if (!stopper.signal.aborted) await this.#player.end();
    } catch (e) {
      if (!stopper.signal.aborted) {
        this.#prepared = false; // the server may have restarted: teach it the voice again
        this.#deps.failed(e instanceof Error ? e.message : String(e));
      }
    } finally {
      this.#player?.kill();
      this.#player = undefined;
      this.#working = undefined;
      this.#queue = stopper.signal.aborted ? [] : this.#queue;
      if (this.#queue.length > 0) this.#working = this.#work(); // said while it was closing
    }
  }
}
