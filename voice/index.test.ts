import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bus } from "../testing/bus.ts";
import { install, readConfig } from "./index.ts";
import type { Deps, Voice, VoiceConfig } from "./index.ts";
import { Sentences } from "./sentences.ts";
import { Speaker, openPlayer, registerVoice, scaled, synth } from "./speaker.ts";
import type { Player } from "./speaker.ts";
import { audioContext, clean, transcribe } from "./stt.ts";
import { Vad, loudness } from "./vad.ts";
import { afterWake, isEcho, isWake } from "./wake.ts";
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
    // Others talking right before: no silence between them and you, one utterance.
    expect(afterWake("Al final tampoco es que fuera tan maravillosa. Kinoko, mira el test.", "kinoko")).toBe("mira el test.");
    expect(afterWake("¿Y qué más da? Oye kinoko, para.", "kinoko")).toBe("para.");
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

type FakeVoice = Voice & { log: string[] };
/** A speaker that writes down what it was asked. */
function fakeVoice(): FakeVoice {
  const voice: FakeVoice = {
    log: [],
    recent: [],
    speaking: false,
    say: (s) => {
      voice.log.push(`say ${s}`);
      voice.recent = [...voice.recent, s];
    },
    end: () => void voice.log.push("end"),
    stop: () => void voice.log.push("stop"),
    duck: (on) => void voice.log.push(on ? "duck" : "unduck"),
  };
  return voice;
}

describe("the voice extension", () => {
  const config: VoiceConfig = { stt: { command: ["whisper"] }, wake: "kinoko", record: ["rec"], tts: { http: "http://tts/v1/audio/speech", voice: "wheatley" } };

  /** The extension on a fake microphone: `say` plays audio into it; `texts` is what whisper "hears", in order. */
  function setup(texts: string[], cfg: VoiceConfig | string = config): { bus: Bus; say: (pcm: Int16Array) => Promise<void>; clock: { now: number }; mics: () => number; stopped: () => number; fail: (why: string) => void; voice: FakeVoice } {
    const voice = fakeVoice();
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
      speaker: (tts) => {
        voice.log.push(`voice ${tts.voice}`);
        return voice;
      },
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
      voice,
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

  test("voice mode reads the reply aloud as it is written; a new run, Esc or an abort silence it; /voice quiet keeps it listening only", async () => {
    const s = setup([]);
    s.bus.emit("agent_event", { type: "message_delta", delta: "Off: nothing is said. " });
    await s.bus.press("ctrl-space");
    expect(s.voice.log).toEqual(["voice wheatley"]);
    s.bus.emit("agent_event", { type: "run_start", prompt: "hola" });
    for (const delta of ["Vale, lo ", "he mirado. El fallo ", "estaba en la carga.\n\n```ts\nconst x = 1;\n```\nYa está"]) s.bus.emit("agent_event", { type: "message_delta", delta });
    s.bus.emit("agent_event", { type: "message_end", message: { id: "a", role: "assistant", content: "" } });
    expect(s.voice.log.slice(1)).toEqual(["stop", "say Vale, lo he mirado.", "say El fallo estaba en la carga.", "say Ya está", "end"]);
    s.voice.log.length = 0;
    s.bus.emit("interrupt", undefined);
    s.bus.emit("agent_event", { type: "run_end", reason: "aborted" });
    expect(s.voice.log).toEqual(["stop", "stop"]);
    expect(await s.bus.command("voice")!("quiet")).toContain("does not talk");
    s.voice.log.length = 0;
    s.bus.emit("agent_event", { type: "message_delta", delta: "Callado. " });
    expect(s.voice.log).toEqual([]);
    await s.bus.command("voice")!("talk");
    await s.bus.press("ctrl-space"); // off: silence, and no more speaking
    expect(s.voice.log).toEqual(["stop"]);
    await s.bus.command("voice")!("glados");
    await s.bus.press("ctrl-space");
    expect(s.voice.log.at(-1)).toBe("voice glados");
  });

  test("someone speaking while kinoko talks: quieter at once; back up when it was not for kinoko", async () => {
    const s = setup(["Pásame la sal", "Kinoko, para"]);
    await s.bus.press("ctrl-space");
    s.voice.log.length = 0;
    await s.say(utterance());
    expect(s.voice.log).toEqual(["duck", "unduck"]);
    s.voice.log.length = 0;
    await s.say(utterance());
    expect(s.voice.log).toEqual(["duck", "unduck", "stop"]);
    expect(s.bus.sent).toEqual([{ text: "para", as: "steer_now" }]);
  });

  test("talking to it stops its voice; its own voice through the microphone is not taken for the user", async () => {
    const s = setup(["Kinoko, el fallo estaba en la función de carga", "Kinoko, para"]);
    await s.bus.press("ctrl-space");
    s.voice.say("Kinoko, el fallo estaba en la función de carga.");
    s.voice.log.length = 0;
    await s.say(utterance()); // kinoko saying its own name, heard back
    expect(s.bus.sent).toEqual([]);
    await s.say(utterance());
    expect(s.bus.sent).toEqual([{ text: "para", as: "steer_now" }]);
    expect(s.voice.log).toEqual(["duck", "unduck", "duck", "unduck", "stop"]); // its own voice: back up, not stopped
  });
});

/** A player that writes down its audio. */
function fakePlayer(log: string[]): Player {
  return { write: (chunk) => void log.push(`play ${new TextDecoder().decode(chunk)}`), gain: (g) => void log.push(`gain ${g}`), end: async () => void log.push("end"), kill: () => void log.push("kill") };
}

/** Until the speaker has said all it had. */
async function silent(speaker: Speaker): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- polling is the point
  while (speaker.speaking) await Bun.sleep(5);
}

describe("speaking", () => {
  test("sentences come out whole as the reply streams: lists, links, emphasis read plainly; code and tables left out", () => {
    const s = new Sentences();
    const out: string[] = [];
    const reply = "## Hecho\nHe cambiado **dos** cosas: el `timeout` (3.5 s) y [el README](https://x.y/z). Mira:\n1. Primero, la carga.\n- Luego src/loop.ts\n| a | b |\n|---|---|\n```\nnpm test\n```\n¿Te vale? 🍄";
    for (let i = 0; i < reply.length; i += 3) out.push(...s.push(reply.slice(i, i + 3)));
    out.push(...s.flush());
    expect(out).toEqual(["Hecho", "He cambiado dos cosas: el timeout (3.5 s) y el README.", "Mira:", "Primero, la carga.", "Luego src/loop.ts", "¿Te vale?"]);
  });

  test("a sentence is said as soon as it ends, before the line does", () => {
    const s = new Sentences();
    expect(s.push("Vale. Lo")).toEqual(["Vale."]);
    expect(s.push(" miro")).toEqual([]);
    expect(s.flush()).toEqual(["Lo miro"]);
  });

  test("the speaker: one player for the reply, sentences in order, the voice taught first; stop is silence at once", async () => {
    const log: string[] = [];
    let release: (() => void) | undefined;
    const speaker = new Speaker({
      synth: async function* (text, signal) {
        if (text === "slow") await new Promise<void>((r) => (release = r));
        if (signal.aborted) return;
        yield new TextEncoder().encode(`<${text}>`);
      },
      player: () => fakePlayer(log),
      prepare: async () => void log.push("prepare"),
      failed: (why) => void log.push(`failed ${why}`),
    });
    speaker.say("uno");
    speaker.say("dos");
    speaker.end();
    await silent(speaker);
    expect(log).toEqual(["prepare", "gain 1", "play <uno>", "play <dos>", "end", "kill"]);
    log.length = 0;
    speaker.say("slow");
    speaker.say("never");
    await Bun.sleep(10);
    speaker.stop();
    release?.();
    await silent(speaker);
    expect(log).toEqual(["gain 1", "kill", "kill"]); // killed at once (and again on the way out); "never" not made
  });

  test("the player is fed in real time, a quarter of a second ahead, so a lower volume is heard at once", async () => {
    mkdirSync(ROOT, { recursive: true });
    const out = join(ROOT, "played.pcm");
    const player = openPlayer(24_000, ["sh", "-c", `cat > ${out}`]);
    const at = performance.now();
    player.write(new Uint8Array(24_000 * 2)); // a second of audio, made at once
    player.gain(0.2);
    await player.end();
    expect(performance.now() - at).toBeGreaterThan(650); // fed as it is heard, not all at once
    const played = new Uint8Array(await Bun.file(out).arrayBuffer());
    expect(played.length).toBe(24_000 * 2);
    expect(scaled(Uint8Array.of(0x10, 0x27), 0.5)).toEqual(Uint8Array.of(0x88, 0x13)); // 10000 → 5000
  });

  test("a backend that fails: said once, and the voice taught again next time", async () => {
    const log: string[] = [];
    let fail = true;
    const speaker = new Speaker({
      synth: async function* (text) {
        if (fail) throw new Error("unknown voice 'wheatley'");
        yield new TextEncoder().encode(text);
      },
      player: () => fakePlayer(log),
      prepare: async () => void log.push("prepare"),
      failed: (why) => void log.push(`failed ${why}`),
    });
    speaker.say("hola");
    speaker.end();
    await silent(speaker);
    fail = false;
    speaker.say("hola");
    speaker.end();
    await silent(speaker);
    expect(log).toEqual(["prepare", "gain 1", "failed unknown voice 'wheatley'", "kill", "prepare", "gain 1", "play hola", "end", "kill"]);
  });

  test("an OpenAI-compatible server: asked for streamed PCM in the voice; a voice from ~/.kinoko/voices registered, latents first", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        bodies.push((await req.json()) as Record<string, unknown>);
        return new URL(req.url).pathname.endsWith("/speech") ? new Response("PCMDATA") : Response.json({ status: "registered" });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/v1/audio/speech`;
      const chunks: string[] = [];
      for await (const c of synth({ http: url, voice: "wheatley", language: "Spanish" })("Hola.", AbortSignal.timeout(5000))) chunks.push(new TextDecoder().decode(c));
      expect(chunks.join("")).toBe("PCMDATA");
      expect(bodies[0]).toMatchObject({ input: "Hola.", voice: "wheatley", language: "Spanish", response_format: "pcm" });
      mkdirSync(ROOT, { recursive: true });
      writeFileSync(join(ROOT, "wheatley.txt"), "Te estarás preguntando.\n");
      writeFileSync(join(ROOT, "wheatley.spk"), "SPK");
      writeFileSync(join(ROOT, "wheatley.rvq"), "RVQ");
      writeFileSync(join(ROOT, "wheatley.wav"), "WAV");
      expect(await registerVoice(url, "wheatley", ROOT)).toBe(true);
      expect(bodies[1]).toEqual({ name: "wheatley", ref_text: "Te estarás preguntando.", spk_b64: btoa("SPK"), rvq_b64: btoa("RVQ") });
      expect(await registerVoice(url, "nadie", ROOT)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("its own voice is told from the user's: mostly its recent words, three or more of them", () => {
    const said = ["Vale, lo he mirado.", "El fallo estaba en la función de carga."];
    expect(isEcho("el fallo estaba en la función", said)).toBe(true);
    expect(isEcho("para", said)).toBe(false);
    expect(isEcho("mira por qué falla el test de la build", said)).toBe(false);
  });
});
