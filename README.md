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
| `notify` | When a run of 30 s or more ends, a desktop notification and, with `KINOKO_NTFY` set, one on the phone through [ntfy](https://ntfy.sh). Quiet while kinoko's window has focus (Hyprland). A `notify` tool for the model too. |
| `permission-gate` | Gates dangerous shell commands: a hardline nothing opens (`rm -rf /`, mkfs...), and `sudo`, `rm -rf`, `chmod 777`... ask you first (the TUI, the phone, Telegram) unless `KINOKO_YOLO=1`. Needs a kinoko with approvals. |
| `plan-mode` | Read-only: blocks `write`, `edit` and any bash command that is not plainly read-only. |
| `telegram` | `telegram_send`: the model sends you a file in the Telegram chat paired in kinoko's `/integrations` ("send me the report on Telegram"), up to 50 MB, as it is. |
| `vision` | `view` and `screenshot`: the model looks at pictures and videos (any format ffmpeg decodes, scaled; a video as frames spread over it) and at the screen or the focused window. Needs a vision model and a kinoko whose tools can answer with images. |
| `web` | `web_search` and `web_fetch`. Searches with Tavily, Exa or your own SearXNG when set up (all free, see below), else Brave's, DuckDuckGo's and Bing's pages and Wikipedia; scraped results must be about the query. Pages as markdown with links and code blocks. |

## Install

In kinoko, open the menu with `/` and pick **extensions**: it lists this repo's extensions (fetched
with git into `~/.kinoko/registry/`). Enter installs or updates one into `~/.kinoko/ext/<name>/`;
Del twice removes it. Either is in effect at once, no restart.

By hand: copy a folder to `~/.kinoko/ext/<name>/` (or `./.kinoko/ext/<name>/` for one project),
then run `bun install` in it when its `package.json` has dependencies.

## Web search that does not give up

Without a key, `web_search` reads search engines' pages, and they turn scripts away after a few
searches in a row. Any of these makes it reliable; they are free, and tried first in this order:

- **Tavily** (1,000 searches a month, no card): sign up at [tavily.com](https://tavily.com), copy the key.
- **Exa** (free credits, no card): sign up at [exa.ai](https://exa.ai), copy the key.
- **SearXNG**, your own (no key, no limit), with Docker:
  `docker run -d --name searxng --restart unless-stopped -p 127.0.0.1:8888:8080 -v ~/.config/searxng:/etc/searxng searxng/searxng`,
  then in `~/.config/searxng/settings.yml` add `json` to `search: formats:` (`formats: [html, json]`)
  and `docker restart searxng`.

Put them in `~/.kinoko/web.json` (`chmod 600` it), only the ones you have:

```json
{ "tavily": "tvly-...", "exa": "...", "searxng": "http://127.0.0.1:8888" }
```

or in the environment (`TAVILY_API_KEY`, `EXA_API_KEY`, `SEARXNG_URL`; `BRAVE_API_KEY` works too).
It is read on every search: no restart.

## Write one

A folder with:

- `index.ts`: a default export that takes kinoko's handle (`on`, `registerTool`, `registerCommand`,
  `registerRenderer`, `log`). Import kinoko's types with `import type { ... } from "../api.ts"` only: the folder is
  copied alone, and type imports vanish at runtime. Nothing else outside the folder.
- `package.json`: `description` (shown in kinoko's list) and, when it needs them, `dependencies`
  (kinoko runs `bun install` in the folder when it installs it, e.g. puppeteer).
- `index.test.ts`: tests with `bun:test`, using `testing/bus.ts` as kinoko.

`bun run check` (oxlint, tsc, tests) must pass with zero warnings.
