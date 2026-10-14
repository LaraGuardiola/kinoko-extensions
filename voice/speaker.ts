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
export type TtsBackend = ({ http: string; key?: string } | { command: string[] }) & {
  /** A cloned voice (~/.kinoko/voices/<name>.*) or one the server has; none: the model's own. */
  voice?: string;
  language?: string;
  /** How free the delivery is: lower is calmer and flatter (Qwen3-TTS: 0.9 unless set). */
  temperature?: number;
  rate?: number;
};

export const VOICES = join(homedir(), ".kinoko", "voices");
const PLAY = (rate: number): string[] => ["pw-play", "--raw", "--rate", String(rate), "--channels", "1", "--format", "s16", "-"];

/** The audio of one sentence, as it is made. */
export type Synth = (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;

export interface Player {
  write(chunk: Uint8Array): void;
  /** No more audio: resolves once what was written has been heard. */
  end(): Promise<void>;
  kill(): void;
}

/** pw-play reading raw PCM on its stdin. */
export function openPlayer(rate: number): Player {
  const proc = Bun.spawn(PLAY(rate), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  return {
    write: (chunk) => void proc.stdin.write(chunk),
    end: async () => {
      await proc.stdin.end();
      await proc.exited;
    },
    kill: () => proc.kill(),
  };
}

/** A sentence's audio from the backend. */
export function synth(backend: TtsBackend): Synth {
  return async function* (text, signal) {
    if ("http" in backend) {
      const body = { model: "tts", input: text, voice: backend.voice, language: backend.language, temperature: backend.temperature, response_format: "pcm" };
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
