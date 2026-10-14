import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bus } from "../testing/bus.ts";
import { install, readConfig } from "./index.ts";
import type { Deps, VoiceConfig } from "./index.ts";
import { audioContext, clean, transcribe } from "./stt.ts";
import { Vad, loudness } from "./vad.ts";
import { afterWake, isWake } from "./wake.ts";
import { wav } from "./wav.ts";

const ROOT = join(import.meta.dir, `.tmp-voice-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const RATE = 16_000;
/** `ms` of a tone at `amp` (speech, near enough for a loudness detector), or of faint noise. */
function sound(ms: number, amp: number): Int16Array {
  const n = (RATE * ms) / 1000;
  return Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin(i / 3) + (Math.sin(i * 12.9898) * 43_758.5453 % 1) * 30));
}
const quiet = (ms: number): Int16Array => sound(ms, 0);
const speech = (ms: number): Int16Array => sound(ms, 6000);

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("voice activity", () => {
  test("speech over a quiet room: one start, one utterance with a little from before it", () => {
    const vad = new Vad();
    const events = vad.push(concat(quiet(1000), speech(800), quiet(1000)));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    const end = events[1];
    if (end?.type !== "end") throw new Error("no end");
    const seconds = end.pcm.length / RATE;
    expect(seconds).toBeGreaterThan(0.8 + 0.2); // the speech, the pre-roll and the quiet that ended it
    expect(seconds).toBeLessThan(0.8 + 1 + 0.75);
  });

  test("a click, a pause inside a sentence, chunks of any size", () => {
    const vad = new Vad();
    expect(vad.push(concat(quiet(500), speech(60), quiet(500)))).toEqual([]); // too short to be speech
    const audio = concat(speech(600), quiet(400), speech(600), quiet(900)); // a breath is not the end
    const events = [];
    for (let i = 0; i < audio.length; i += 777) events.push(...vad.push(audio.subarray(i, i + 777)));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });

  test("a loud room raises the floor: steady noise is not speech, a voice over it is", () => {
    const vad = new Vad();
    const hum = sound(3000, 900);
    expect(vad.push(hum)).toEqual([]);
    expect(vad.push(concat(sound(800, 9000), sound(1000, 900))).map((e) => e.type)).toEqual(["start", "end"]);
  });

  test("an utterance that never stops is cut at the most allowed; reset forgets one going", () => {
    const vad = new Vad({ maxMs: 1000 });
    expect(vad.push(concat(quiet(300), speech(1500))).map((e) => e.type)).toEqual(["start", "end", "start"]);
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(loudness(quiet(20))).toBeLessThan(-50);
  });
});

describe("the wake word", () => {
  test("kinoko, as whisper may write it, within the first words", () => {
    expect(afterWake("Kinoko, mira por qué falla el test.", "kinoko")).toBe("mira por qué falla el test.");
    expect(afterWake("Oye, Kinoko, para un momento", "kinoko")).toBe("para un momento");
    expect(afterWake("Quinoco mira el test", "kinoko")).toBe("mira el test");
    expect(afterWake("Kinokoko.", "kinoko")).toBe("");
    expect(afterWake("Kinoko", "kinoko")).toBe("");
    expect(afterWake("Kínogo, sigue", "kinoko")).toBe("sigue");
  });

  test("not for kinoko: other words, the name too late, words that only look close", () => {
    expect(afterWake("Mira por qué falla el test", "kinoko")).toBeUndefined();
    expect(afterWake("Ya te dije que kinoko lo arregla", "kinoko")).toBeUndefined();
    expect(afterWake("Cinco minutos más", "kinoko")).toBeUndefined();
    expect(isWake("kimono", "kinoko")).toBe(false);
    expect(isWake("jarvis", "Jarvis")).toBe(true);
  });
});

describe("speech to text", () => {
  test("whisper's window is sized to the clip; its notes and timestamps come out", () => {
    expect(audioContext(2)).toBe(150);
    expect(audioContext(60)).toBe(1500);
    expect(clean("[00:00:00.000 --> 00:00:02.000]   Kinoko, mira el test.\n")).toBe("Kinoko, mira el test.");
    expect(clean("[BLANK_AUDIO]")).toBe("");
    expect(clean(" (música) Hola *risas* ")).toBe("Hola");
  });

  test("a command gets the utterance as a WAV and the window; its output is the text", async () => {
    mkdirSync(ROOT, { recursive: true });
    const script = join(ROOT, "fake-whisper.sh");
    writeFileSync(script, 'printf "[00:00:00.000 --> 00:00:01.000]  heard %s bytes, ac %s\\n" "$(wc -c < "$1")" "$2"\n');
    const pcm = speech(1000);
    const text = await transcribe({ command: ["sh", script, "{wav}", "{ac}"] }, pcm, RATE, AbortSignal.timeout(5000));
    expect(text).toBe(`heard ${44 + pcm.length * 2} bytes, ac 100`);
    await expect(transcribe({ command: ["sh", "-c", "echo no model >&2; exit 3"] }, pcm, RATE, AbortSignal.timeout(5000))).rejects.toThrow("sh failed (3): no model");
  });

  test("an OpenAI-compatible server gets the WAV as a form; its JSON's text is the text", async () => {
    let got: { get: (name: string) => unknown } | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        got = (await req.formData()) as unknown as { get: (name: string) => unknown };
        return Response.json({ text: " Kinoko, hola " });
      },
    });
    try {
      const text = await transcribe({ http: `http://127.0.0.1:${server.port}/v1/audio/transcriptions`, language: "es" }, speech(500), RATE, AbortSignal.timeout(5000));
      expect(text).toBe("Kinoko, hola");
      expect(got?.get("language")).toBe("es");
      expect(((got?.get("file") as File | null)?.size ?? 0) > 44).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("a WAV header for 16-bit mono", () => {
    const bytes = wav(Int16Array.of(1, -1), RATE);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(RATE);
    expect(bytes.length).toBe(48);
  });
});

const utterance = (): Int16Array => concat(quiet(300), speech(600), quiet(900));

describe("the voice extension", () => {
  const config: VoiceConfig = { stt: { command: ["whisper"] }, wake: "kinoko", record: ["rec"] };

  /** The extension on a fake microphone: `say` plays audio into it; `texts` is what whisper "hears", in order. */
  function setup(texts: string[], cfg: VoiceConfig | string = config): { bus: Bus; say: (pcm: Int16Array) => Promise<void>; clock: { now: number }; mics: () => number; stopped: () => number; fail: (why: string) => void } {
    const bus = new Bus();
    const clock = { now: 0 };
    let feed: ((pcm: Int16Array) => void) | undefined;
    let end: ((why?: string) => void) | undefined;
    let opened = 0;
    let stops = 0;
    const deps: Deps = {
      config: async () => cfg,
      openMic: (_argv, heard, ended) => {
        opened++;
        feed = heard;
        end = ended;
        return { stop: () => void stops++ };
      },
      transcribe: async () => texts.shift() ?? "",
      now: () => clock.now,
    };
    install(bus, deps);
    return {
      bus,
      clock,
      say: async (pcm) => {
        feed?.(pcm);
        await Bun.sleep(5);
      },
      mics: () => opened,
      stopped: () => stops,
      fail: (why) => end?.(why),
    };
  }

  test("Ctrl+Space opens the microphone; what starts with kinoko is sent, the rest is not; Ctrl+Space closes it", async () => {
    const s = setup(["Kinoko, mira por qué falla el test.", "Pásame la sal", "Oye kinoko, gracias"]);
    expect(await s.bus.press("ctrl-space")).toBe(true);
    expect(s.mics()).toBe(1);
    expect(s.bus.shown).toBe("● listening");
    await s.say(utterance());
    await s.say(utterance());
    await s.say(utterance());
    expect(s.bus.sent).toEqual([
      { text: "mira por qué falla el test.", as: "steer_now" },
      { text: "gracias", as: "steer_now" },
    ]);
    expect(s.bus.shown).toBe("● listening");
    await s.bus.press("ctrl-space");
    expect(s.stopped()).toBe(1);
    expect(s.bus.shown).toBeUndefined();
  });

  test('"kinoko" alone: the next words are for kinoko, for a few seconds', async () => {
    const s = setup(["Kinoko.", "mira el test", "y esto no"]);
    await s.bus.press("ctrl-space");
    await s.say(utterance());
    expect(s.bus.shown).toBe("● kinoko hears you");
    await s.say(utterance());
    expect(s.bus.sent.map((m) => m.text)).toEqual(["mira el test"]);
    await s.say(utterance()); // the window closed with what was said in it
    expect(s.bus.sent.map((m) => m.text)).toEqual(["mira el test"]);

    const late = setup(["Kinoko.", "mira el test"]);
    await late.bus.press("ctrl-space");
    await late.say(utterance());
    late.clock.now += 9_000;
    await late.say(utterance());
    expect(late.bus.sent).toEqual([]);
  });

  test("not set up, or the microphone fails: the status says why and the microphone is closed", async () => {
    const s = setup([], "no ~/.kinoko/voice.json: see the voice extension's README");
    await s.bus.press("ctrl-space");
    expect(s.mics()).toBe(0);
    expect(s.bus.shown).toBe("voice: no ~/.kinoko/voice.json: see the voice extension's README");
    expect(await s.bus.command("voice")!("")).toStartWith("Voice is not set up");

    const f = setup([]);
    await f.bus.press("ctrl-space");
    f.fail("pw-record stopped (1): no such target");
    expect(f.bus.shown).toBe("voice: pw-record stopped (1): no such target");
    await f.bus.press("ctrl-space"); // opens again
    expect(f.mics()).toBe(2);
  });

  test("the config: a command or an http endpoint; the defaults for the rest", async () => {
    mkdirSync(ROOT, { recursive: true });
    const path = join(ROOT, "voice.json");
    writeFileSync(path, JSON.stringify({ stt: { http: "http://x/v1/audio/transcriptions" } }));
    expect(await readConfig(path)).toMatchObject({ wake: "kinoko", record: expect.arrayContaining(["pw-record"]) });
    writeFileSync(path, JSON.stringify({ stt: { command: ["~/whisper/whisper-cli", "-f", "{wav}"] } }));
    expect(await readConfig(path)).toMatchObject({ stt: { command: [join(homedir(), "whisper/whisper-cli"), "-f", "{wav}"] } });
    writeFileSync(path, JSON.stringify({ stt: {} }));
    expect(await readConfig(path)).toContain('needs "stt"');
    expect(await readConfig(join(ROOT, "none.json"))).toStartWith("no ");
  });
});
