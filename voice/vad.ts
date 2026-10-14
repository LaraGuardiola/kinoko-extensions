// Where speech starts and ends in the microphone's stream. Each 20 ms frame's loudness is compared
// with the room's noise floor, which follows the room while nobody speaks (down at once, up
// slowly). Speech starts when most of the last frames stand above the floor, and ends after a
// stretch with hardly any; the utterance keeps a little audio from before its start, so its first
// syllable is not clipped. The first moments only learn how loud the room is.

export interface VadOptions {
  rate: number;
  /** How much speech starts an utterance. */
  startMs: number;
  /** How much quiet ends it. */
  endMs: number;
  /** Audio kept from before the start. */
  preRollMs: number;
  /** An utterance this long ends here, quiet or not. */
  maxMs: number;
  /** How far above the noise floor a frame must be to count as speech. */
  marginDb: number;
  /** Below this a frame is quiet whatever the floor (a muted microphone). */
  minDb: number;
}

export const VAD_DEFAULTS: VadOptions = { rate: 16_000, startMs: 200, endMs: 700, preRollMs: 1000, maxMs: 30_000, marginDb: 7, minDb: -80 };

export type VadEvent = { type: "start" } | { type: "end"; pcm: Int16Array };

const FRAME_MS = 20;
const WARMUP_MS = 400;
/** How many frames make `ms`. */
const frames = (ms: number): number => Math.max(1, Math.round(ms / FRAME_MS));

/** A frame's loudness in dBFS. */
export function loudness(frame: Int16Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return 20 * Math.log10(Math.max(rms, 1) / 32_768);
}

export class Vad {
  #o: VadOptions;
  #frameLen: number;
  #pending: number[] = [];
  #floor: number | undefined;
  /** The last frames, voiced or not, to decide a start. */
  #recent: boolean[] = [];
  /** Frames kept from before a start. */
  #before: Int16Array[] = [];
  #speech: Int16Array[] | undefined;
  /** While speaking, the last frames, voiced or not, to decide the end. */
  #tail: boolean[] = [];
  /** The first frames only learn the room: a microphone opening clicks and starts from silence. */
  #warmup: number[] = [];

  constructor(options: Partial<VadOptions> = {}) {
    this.#o = { ...VAD_DEFAULTS, ...options };
    this.#frameLen = (this.#o.rate * FRAME_MS) / 1000;
  }

  /** True while an utterance is going. */
  get speaking(): boolean {
    return this.#speech !== undefined;
  }

  /** Audio in, in any chunking: where speech started, and each utterance once it ended. */
  push(chunk: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    for (const s of chunk) this.#pending.push(s);
    while (this.#pending.length >= this.#frameLen) {
      const frame = Int16Array.from(this.#pending.splice(0, this.#frameLen));
      const event = this.#frame(frame);
      if (event) events.push(event);
    }
    return events;
  }

  /** Drops what was heard: the next sound starts from nothing. */
  reset(): void {
    this.#pending = [];
    this.#recent = [];
    this.#before = [];
    this.#speech = undefined;
    this.#tail = [];
  }

  #frame(frame: Int16Array): VadEvent | undefined {
    const o = this.#o;
    const level = loudness(frame);
    if (this.#floor === undefined) {
      this.#warmup.push(level);
      if (this.#warmup.length < frames(WARMUP_MS)) return undefined;
      this.#floor = this.#warmup.toSorted((a, b) => a - b)[Math.floor(this.#warmup.length / 2)]; // the median
    }
    const floor = this.#floor ?? level;
    const voiced = level > o.minDb && level > floor + o.marginDb;

    if (this.#speech !== undefined) {
      this.#speech.push(frame);
      // The end: hardly a voiced frame in the last stretch (a room's stray noise does not keep it going).
      this.#tail.push(voiced);
      if (this.#tail.length > frames(o.endMs)) this.#tail.shift();
      const ended = this.#tail.length === frames(o.endMs) && this.#tail.filter(Boolean).length <= frames(o.endMs) * 0.15;
      if (ended || this.#speech.length >= frames(o.maxMs)) return this.#end();
      return undefined;
    }

    // Nobody speaking: the floor follows the room.
    this.#floor = level < floor ? level : floor + (level - floor) * 0.01;
    this.#before.push(frame);
    if (this.#before.length > frames(o.preRollMs)) this.#before.shift();
    this.#recent.push(voiced);
    if (this.#recent.length > frames(o.startMs)) this.#recent.shift();
    const loud = this.#recent.filter(Boolean).length;
    if (this.#recent.length < frames(o.startMs) || loud < frames(o.startMs) * 0.6) return undefined;
    this.#speech = [...this.#before];
    this.#before = [];
    this.#recent = [];
    this.#tail = [];
    return { type: "start" };
  }

  #end(): VadEvent {
    const heard = this.#speech ?? [];
    this.#speech = undefined;
    this.#tail = [];
    const pcm = new Int16Array(heard.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of heard) {
      pcm.set(f, at);
      at += f.length;
    }
    return { type: "end", pcm };
  }
}
