# kinoko-extensions 🍄

Extensions for [kinoko](https://github.com/LaraGuardiola/kinoko), one folder each, installed one by one.

| Extension | What it does |
|---|---|
| `check-early` | After 4 source files written with no build, typecheck, lint or test in between, asks the model to run one. |
| `cliamp` | `music`: controls [cliamp](https://github.com/bjarneo/cliamp): songs from `~/Music` by name, a folder or a whole discography, paths or URLs; YouTube searched and streamed, never downloaded (a song, or a whole playlist: an album, a soundtrack; needs [yt-dlp](https://github.com/yt-dlp/yt-dlp)); radio stations by genre; queue, remove, clear, volume, seek, shuffle, EQ. Starts cliamp in the background when it is not running. |
| `delegate` | Hands a task to another coding agent (opencode, pi, Claude Code, Codex, another kinoko: the installed ones), run without its UI in the project as a background job: watch it under ⚙ shells; kinoko is woken with its answer. `~/.kinoko/delegate.json` adds more. Needs a kinoko with background jobs. |
| `github` | `github` (read-only) and `github_write` through `gh`: pull requests with checks, reviews and diffs, issues, CI runs, and a failed run's log cut to the error. Comments, new issues and PRs on the write side. |
| `herdr` | Inside [herdr](https://herdr.dev), reports kinoko as an agent: herdr's sidebar shows it, and Flux for Android gets **Live**, the pane sized to the phone. |
| `mermaid` | ```` ```mermaid ```` blocks drawn in the terminal: flowcharts (subgraphs framed), state diagrams, sequence diagrams, pie charts. Fits the width: redraws top-down, then lists the edges. Needs a kinoko with `registerRenderer`. |
| `latex` | LaTeX math drawn in Unicode: `$$…$$` and `\[…\]` blocks (and ```` ```math ```` / ```` ```latex ```` fences) with fractions stacked, roots, ∑/∫/lim with their limits, matrices, cases and aligned lines; inline `$…$` and `\(…\)` on one line (x², a/b, √x). Too wide, a block goes on one line; what it cannot read stays as source. Needs a kinoko that hands math to renderers (`math`, `math-inline`). |
| `notify` | When a run of 30 s or more ends, a desktop notification and, with `KINOKO_NTFY` set, one on the phone through [ntfy](https://ntfy.sh). Quiet while kinoko's window has focus (Hyprland). A `notify` tool for the model too. The desktop one on Linux and macOS; ntfy anywhere. |
| `permission-gate` | Gates dangerous shell commands: a hardline nothing opens (`rm -rf /`, mkfs...), and `sudo`, `rm -rf`, `chmod 777`... ask you first (the TUI, the phone, Telegram) unless `KINOKO_YOLO=1`. Needs a kinoko with approvals. |
| `plan-mode` | Read-only: blocks `write`, `edit` and any bash command that is not plainly read-only. |
| `telegram` | `telegram_send`: the model sends you a file in the Telegram chat paired in kinoko's `/integrations` ("send me the report on Telegram"), up to 50 MB, as it is. |
| `voice` | Talk with kinoko. Ctrl+Space turns voice mode on (and off): say "kinoko, …" and it is your prompt, or a steer that goes in at once while it works; "kinoko" alone, and the next words are for it. It reads its replies aloud as it writes them, sentence by sentence, in a voice you can clone; Esc or talking to it stops it. Speech to text by [whisper.cpp](https://github.com/ggml-org/whisper.cpp), text to speech by [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp) (Qwen3-TTS), or any OpenAI-compatible servers; set up below. Linux (PipeWire). Needs a kinoko with `registerKey` and `send`. |
| `vision` | `view` and `screenshot`: the model looks at pictures and videos (any format ffmpeg decodes, scaled; a video as frames spread over it) and at the screen or the focused window. Needs a vision model and a kinoko whose tools can answer with images. `screenshot` everywhere but Windows. |
| `web` | `web_search` and `web_fetch`. Searches with Tavily, Exa or your own SearXNG when set up (all free, see below), else Brave's, DuckDuckGo's and Bing's pages and Wikipedia; scraped results must be about the query. Pages as markdown with links and code blocks. |

## Install

In kinoko, open the menu with `/` and pick **extensions**: it lists this repo's extensions (fetched
with git into `~/.kinoko/registry/`). Enter installs or updates one into `~/.kinoko/ext/<name>/`;
Del twice removes it. Either is in effect at once, no restart.

By hand: copy a folder to `~/.kinoko/ext/<name>/` (or `./.kinoko/ext/<name>/` for one project),
then run `bun install` in it when its `package.json` has dependencies.

## Web search that does not give up

Without a key, `web_search` reads search engines' pages, and they turn scripts away after a few
searches in a row. Any of these makes it reliable, and is tried first, in this order (SearXNG
needs no account at all):

- **Tavily** (1,000 searches a month; it may ask for a card): sign up at [tavily.com](https://tavily.com), copy the key.
- **Exa** (free credits to start): sign up at [exa.ai](https://exa.ai), copy the key.
- **SearXNG**, your own (no key, no limit), in Docker or Podman on this computer: in kinoko,
  `/searxng setup`. It writes its settings (`~/.kinoko/searxng`, JSON format on), starts the container
  (or, when Docker refuses your user, gives you the one `!sudo sh ...` line to paste; Podman never
  needs sudo) and tells web_search. With nothing to run it, it says what to install on your system.
  `/searxng` says where it stands, `/searxng use <url>` takes one you already run, `/searxng remove`
  undoes it.

Keys go in `~/.kinoko/web.json` (`chmod 600` it), only the ones you have:

```json
{ "tavily": "tvly-...", "exa": "...", "searxng": "http://127.0.0.1:8888" }
```

or in the environment (`TAVILY_API_KEY`, `EXA_API_KEY`, `SEARXNG_URL`; `BRAVE_API_KEY` works too).
It is read on every search: no restart.

## Talking to kinoko (voice)

Ctrl+Space and kinoko listens ("kinoko, …") and talks back as it writes. Speech to text and text to
speech are backends you choose in `~/.kinoko/voice.json`: a program (whisper.cpp's `whisper-cli`,
piper) or any OpenAI-compatible server (qwentts.cpp's Qwen3-TTS with cloned voices, whisper.cpp's
server, speaches, Kokoro-FastAPI, a cloud API). **[voice/README.md](voice/README.md)** says how to
set up each, cloned voices, and the echo cancelling speakers need.

## Write one

A folder with:

- `index.ts`: a default export that takes kinoko's handle (`on`, `registerTool`, `registerCommand`,
  `registerRenderer`, `registerKey`, `send`, `status`, `log`). Import kinoko's types with `import type { ... } from "../api.ts"` only: the folder is
  copied alone, and type imports vanish at runtime. Nothing else outside the folder.
- `package.json`: `description` (shown in kinoko's list) and, when it needs them, `dependencies`
  (kinoko runs `bun install` in the folder when it installs it, e.g. puppeteer). Only for some
  systems? Say so the npm way, `"os": ["linux", "darwin"]` (`win32` is Windows): elsewhere kinoko
  marks it in the list, does not install it and never loads it. Nothing said: every system.
- `index.test.ts`: tests with `bun:test`, using `testing/bus.ts` as kinoko.

`bun run check` (oxlint, tsc, tests) must pass with zero warnings.
