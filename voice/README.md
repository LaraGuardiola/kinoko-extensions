# voice: talk with kinoko

Press **Ctrl+Space** in kinoko and voice mode is on: kinoko listens, and reads its replies aloud as
it writes them. Press it again and the microphone closes and the voice stops.

- **Say "kinoko, …"** and what follows is your prompt: "Kinoko, mira por qué falla el test".
- **While it works**, what you say goes in at once, as a steer: the reply being written, or the
  command running, is cut and the model reads you next (Alt+X's way).
- **"Kinoko" on its own**, and the next thing you say within 8 seconds is for it, no name needed.
- **It talks** sentence by sentence while the model is still writing, in a voice you can clone.
  Code blocks, tables and links' addresses are not read. **Esc** silences it, and so does talking
  to it.
- **Alone in a quiet room**, `/voice wake off`: everything you say is for kinoko.

The rule above the input says `● listening` while the microphone is open.

It runs on Linux with PipeWire (`pw-record` and `pw-play`). It needs a kinoko with `registerKey` and
`send` (0.4.0 or later). Everything it does is set in `~/.kinoko/voice.json`; the engines that turn
speech into text (STT) and text into speech (TTS) are **backends** you choose there.

## `~/.kinoko/voice.json`

```json
{
  "stt": { "command": ["whisper-cli", "-m", "/models/ggml-small-q5_1.bin", "-l", "es",
                       "-ac", "{ac}", "--prompt", "Kinoko", "-nt", "-np", "-f", "{wav}"] },
  "tts": { "http": "http://127.0.0.1:8091/v1/audio/speech", "voice": "wheatley", "language": "Spanish" },
  "wake": "kinoko",
  "record": ["pw-record", "--target", "kinoko-aec-source", "--raw", "--rate", "16000",
             "--channels", "1", "--format", "s16", "-"]
}
```

| Key | Needed | What it is |
|---|---|---|
| `stt` | yes | How speech becomes text: a [`command`](#stt-a-command) or an [`http`](#stt-a-server) server. |
| `tts` | no | How replies are read aloud: an [`http`](#tts-a-server) server or a [`command`](#tts-a-command). Without it kinoko listens but does not talk. |
| `wake` | no | The name that says something is for kinoko (`"kinoko"`), or `false`: everything said is. |
| `record` | no | The program that records: raw 16 kHz mono 16-bit PCM on its stdout. `pw-record` from the default microphone unless set; set it to record from the [echo-cancelled](#echo-cancelling) one. |

A path that starts with `~/` in a command is your home folder, as in a shell. The file is read
each time voice mode is turned on: change it and press Ctrl+Space twice.

## Speech to text (`stt`)

The extension cuts what the microphone hears into utterances (it waits for a pause) and hands each
one to the backend. Short phrases, one at a time: the backend should be fast on a few seconds of
audio more than good at hours of it.

### STT: a command

```json
"stt": { "command": ["program", "arg", "…", "{wav}"] }
```

The program runs once per utterance and prints the text on stdout. In its arguments, `{wav}` is the
utterance as a WAV file (16 kHz mono) and `{ac}` is whisper's audio window sized to it. Nothing
stays running between utterances, so a model that loads in a blink is what fits here.

**whisper.cpp** (recommended, on the CPU). Build it and fetch a model:

```sh
git clone https://github.com/ggml-org/whisper.cpp ~/Projects/whisper.cpp
cd ~/Projects/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --target whisper-cli
curl -L -o models/ggml-small-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin
```

```json
"stt": {
  "command": ["~/Projects/whisper.cpp/build/bin/whisper-cli",
              "-m", "~/Projects/whisper.cpp/models/ggml-small-q5_1.bin",
              "-l", "es", "-t", "8", "-bs", "1", "-bo", "1",
              "-ac", "{ac}", "--prompt", "Kinoko", "-nt", "-np", "-f", "{wav}"]
}
```

- `-l es`: the language you speak (`en`, `fr`, … or `auto`).
- `-ac {ac}`: **keep it.** Without it whisper works through 30 seconds of audio for every phrase:
  measured on a laptop CPU, 9.5 s for a 2-second phrase with large-v3-turbo, 1.3 s with it.
- `--prompt Kinoko`: teaches whisper the name. Without it the small model wrote "Quinoco".
- `-t 8 -bs 1 -bo 1`: eight threads, greedy decoding: fast enough, and accurate on short phrases.
- Models: `ggml-small-q5_1.bin` (190 MB, 0.2–0.35 s a phrase on an i7-14700HX, the name right
  every time with the prompt) or `ggml-large-v3-turbo-q5_0.bin` (574 MB, 0.85–1.3 s, more
  accurate). Both are multilingual.

### STT: a server

```json
"stt": { "http": "http://127.0.0.1:8092/v1/audio/transcriptions", "language": "es" }
```

Any OpenAI-compatible `/v1/audio/transcriptions`: the WAV goes as a form's `file`, the text comes
back as `{"text": "…"}`.

| Field | What it is |
|---|---|
| `http` | The endpoint. |
| `language` | The language spoken (`"es"`), when the server should not guess it. |
| `model` | The model's name, for servers that serve several (`whisper-1` unless set). |
| `key` | A bearer token, for a cloud API. |

- **whisper.cpp's server** keeps the model loaded: `whisper-server -m <model> --port 8092
  --inference-path /v1/audio/transcriptions`.
- **[speaches](https://github.com/speaches-ai/speaches)**, faster-whisper behind the same API.
- **A cloud API**: `{"http": "https://api.openai.com/v1/audio/transcriptions", "model": "whisper-1",
  "key": "sk-…"}` (or Groq's). Your voice leaves the machine then.

## Text to speech (`tts`)

Each sentence goes to the backend as soon as the model has written it; its audio streams into one
player for the whole reply. A backend that makes speech faster than it is heard (the one below:
about six times) leaves no gaps between sentences.

### TTS: a server

```json
"tts": { "http": "http://127.0.0.1:8091/v1/audio/speech", "voice": "wheatley", "language": "Spanish" }
```

Any OpenAI-compatible `/v1/audio/speech` that streams raw PCM: the extension asks for
`"response_format": "pcm"`, 16-bit mono, and plays it as it arrives.

| Field | What it is |
|---|---|
| `http` | The endpoint. |
| `voice` | The voice: a [cloned one](#cloned-voices) by its name, or one the server has. Left out: the model's own voice. |
| `language` | The language to speak (`"Spanish"`), for servers that take it. |
| `temperature` | How free the delivery is: lower is calmer and flatter (Qwen3-TTS: 0.9 unless set). |
| `rate` | The PCM's sample rate, when it is not 24000. |
| `model` | The model's name, for servers that serve several (a cloud API: `"gpt-4o-mini-tts"`). |
| `key` | A bearer token, for a cloud API. |

**[qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp)** (recommended): Qwen3-TTS (Apache
2.0), Spanish and nine more languages, voices cloned from a few seconds of audio. Its `tts-server`
streams the first audio in about 0.1 s and speaks about six times faster than real time on a laptop
GPU (RTX 4070 Laptop, 1.7B model at Q4_K_M, ~2.6 GB of VRAM). On the CPU it is not faster than real
time beside a running LLM: give it the GPU.

```sh
git clone --recurse-submodules https://github.com/ServeurpersoCom/qwentts.cpp ~/Projects/qwentts.cpp
cd ~/Projects/qwentts.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 && cmake --build build -j --target tts-server qwen-codec
# models from huggingface.co/Serveurperso/Qwen3-TTS-GGUF, into models/:
#   qwen-talker-1.7b-base-Q4_K_M.gguf and qwen-tokenizer-12hz-Q8_0.gguf
./build/tts-server --device CUDA0 --model models/qwen-talker-1.7b-base-Q4_K_M.gguf \
  --codec models/qwen-tokenizer-12hz-Q8_0.gguf --lang Spanish --host 127.0.0.1 --port 8091
```

(Arch with GCC 16: add `-DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-15`.) It must be the **base**
model for cloned voices; the 0.6B one is lighter and a little flatter. Beside a local LLM on the
same GPU, give the LLM fewer layers' experts on the GPU (llama.cpp's `--n-cpu-moe` a few higher) to
leave it room: measured with MiniCPM-V 4.7, `--n-cpu-moe 38` instead of 34 cost about 10 % of its
speed.

Others that speak the same API: [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (light,
fast on a CPU, no cloning), [speaches](https://github.com/speaches-ai/speaches), the
[Chatterbox](https://github.com/devnen/Chatterbox-TTS-Server) servers, or a cloud API:
`{"http": "https://api.openai.com/v1/audio/speech", "model": "gpt-4o-mini-tts", "voice": "alloy",
"key": "sk-…"}`.

### TTS: a command

```json
"tts": { "command": ["piper", "--model", "~/voices/es_ES-davefx-medium.onnx", "--output-raw"], "rate": 22050 }
```

The program runs once per sentence: the sentence on its stdin, raw 16-bit mono PCM on its stdout,
at `rate` (24000 unless set). [Piper](https://github.com/rhasspy/piper) is the classic one: fast on
any CPU, good Spanish voices, no cloning (its voices are 22050 Hz).

### Cloned voices

A cloned voice is a clip in `~/.kinoko/voices/`:

- `<name>.wav`: 10–15 seconds of one person speaking, with no music or effects (24 kHz mono is
  best; `ffmpeg -i in.mp3 -ss 1:45 -to 1:57 -ar 24000 -ac 1 <name>.wav` cuts one out);
- `<name>.txt`: exactly what the clip says.

The accent comes from the clip: Qwen3-TTS's own Spanish sounds Latin American, a clip from Spain
speaks Spanish from Spain. When voice mode starts, the extension teaches the voice to the server
(qwentts.cpp's `POST /v1/audio/voices`; the server forgets them when it restarts, and the extension
teaches them again).

With an LLM on the same GPU, **encode the clip ahead, once**, on the CPU: the server would
otherwise encode it on the GPU, and with the memory the LLM took it may crash.

```sh
~/Projects/qwentts.cpp/build/qwen-codec --device CPU \
  --model ~/Projects/qwentts.cpp/models/qwen-tokenizer-12hz-Q8_0.gguf \
  --talker ~/Projects/qwentts.cpp/models/qwen-talker-1.7b-base-Q4_K_M.gguf \
  -i ~/.kinoko/voices/<name>.wav
```

It writes `<name>.spk` and `<name>.rvq` beside the clip; the extension sends those when they are
there.

## Echo cancelling

With speakers (not headphones) the microphone hears kinoko talking. Whisper transcribes it, and
when kinoko says its own name it would answer itself. PipeWire's WebRTC echo canceller gives a
microphone with what the speakers play taken out: kinoko's voice, and your music too. Measured: a
whole reply spoken with the microphone open, the plain microphone transcribed it, the cancelled
one not a word of it.

Run it as its own small pipewire process, so your main one is not touched and your default
microphone does not change. `~/.config/pipewire/kinoko-echo-cancel.conf`:

```
context.properties = { log.level = 0 }
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}
context.modules = [
    { name = libpipewire-module-rt args = { } flags = [ ifexists nofail ] }
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-echo-cancel
        args = {
            library.name   = aec/libspa-aec-webrtc
            monitor.mode   = true
            audio.rate     = 48000
            audio.channels = 1
            audio.position = [ MONO ]
            aec.args = {
                webrtc.high_pass_filter  = true
                webrtc.noise_suppression = true
                webrtc.gain_control      = true
            }
            capture.props = { node.name = "kinoko-aec-capture" node.passive = true }
            source.props  = { node.name = "kinoko-aec-source" node.description = "Kinoko microphone (echo cancelled)"
                              priority.session = 1 priority.driver = 1 }
        }
    }
]
```

`monitor.mode` takes whatever the default output plays as the echo to remove, and follows it when
the output changes (to a Bluetooth speaker, say). `~/.config/systemd/user/kinoko-echo-cancel.service`:

```ini
[Unit]
Description=kinoko's echo-cancelled microphone (PipeWire WebRTC AEC)
After=pipewire.service wireplumber.service
BindsTo=pipewire.service

[Service]
ExecStart=/usr/bin/pipewire -c %h/.config/pipewire/kinoko-echo-cancel.conf
Restart=on-failure

[Install]
WantedBy=pipewire.service
```

`systemctl --user enable --now kinoko-echo-cancel`, then record from it: `"record": ["pw-record",
"--target", "kinoko-aec-source", "--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "-"]`.
It needs PipeWire 1.0 or later with the WebRTC plugin (`libspa-aec-webrtc`).

## In kinoko

| | |
|---|---|
| **Ctrl+Space** | Voice mode on and off. |
| **Esc** | Silences its voice (and stops a run, as always). |
| `/voice` | Whether it is listening, the voice, the last five things it heard and what became of each, the last problem. |
| `/voice <name>` | Talk with that voice the next time voice mode is on (`~/.kinoko/voices/<name>.*`); `/voice none`: the model's own. |
| `/voice quiet` / `/voice talk` | Listen without talking, and talk again. |
| `/voice wake off` / `/voice wake on` | No name needed, and back to "kinoko, …". |

## When something is off

- **It does not hear you**: `/voice` lists what it heard lately. Nothing there: the microphone is
  too quiet (`wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 0.7`) or `record` points at the wrong source.
  Heard but "not for kinoko": the name did not start a sentence, or whisper spelled it too far off.
- **People talking nearby** are heard too. They are not sent (no "kinoko"), and kinoko keeps
  talking over them; only "kinoko, …" stops it.
- **It answers itself**: no echo cancelling. Set it up, or use headphones.
- **It went silent**: `/voice` shows the last problem (the server down, the voice unknown to it).
  A player stuck after the output changed is killed and the next sentence plays.
- **Whisper invents** short phrases on noise ("¡Suscríbete!", "Gracias."): they are dropped when
  no name is needed.
