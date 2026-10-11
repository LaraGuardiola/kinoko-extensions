# kinoko-extensions 🍄

Extensions for [kinoko](https://github.com/LaraGuardiola/kinoko), one folder each, installed one by one.

| Extension | What it does |
|---|---|
| `check-early` | After 4 source files written with no build, typecheck, lint or test in between, asks the model to run one. |
| `herdr` | Inside [herdr](https://herdr.dev), reports kinoko as an agent: herdr's sidebar shows it, and Flux for Android gets **Live**, the pane sized to the phone. |
| `mermaid` | ```` ```mermaid ```` blocks drawn in the terminal: flowcharts (subgraphs framed), state diagrams, sequence diagrams, pie charts. Fits the width: redraws top-down, then lists the edges. Needs a kinoko with `registerRenderer`. |
| `permission-gate` | Blocks dangerous shell commands: a hardline nothing opens (`rm -rf /`, mkfs...), a gate for `sudo`, `rm -rf`, `chmod 777`... that `KINOKO_YOLO=1` opens. |
| `plan-mode` | Read-only: blocks `write`, `edit` and any bash command that is not plainly read-only. |
| `web` | `web_search` and `web_fetch`, no key needed: Bing's feed, then Bing's page, DuckDuckGo, Marginalia (your `SEARXNG_URL` or `BRAVE_API_KEY` first when set); pages as markdown with links and code blocks. |

## Install

In kinoko, open the menu with `/` and pick **extensions**: it lists this repo's extensions (fetched
with git into `~/.kinoko/registry/`). Enter installs or updates one into `~/.kinoko/ext/<name>/`;
Del twice removes it. Either is in effect at once, no restart.

By hand: copy a folder to `~/.kinoko/ext/<name>/` (or `./.kinoko/ext/<name>/` for one project),
then run `bun install` in it when its `package.json` has dependencies.

## Write one

A folder with:

- `index.ts`: a default export that takes kinoko's handle (`on`, `registerTool`, `registerCommand`,
  `registerRenderer`, `log`). Import kinoko's types with `import type { ... } from "../api.ts"` only: the folder is
  copied alone, and type imports vanish at runtime. Nothing else outside the folder.
- `package.json`: `description` (shown in kinoko's list) and, when it needs them, `dependencies`
  (kinoko runs `bun install` in the folder when it installs it, e.g. puppeteer).
- `index.test.ts`: tests with `bun:test`, using `testing/bus.ts` as kinoko.

`bun run check` (oxlint, tsc, tests) must pass with zero warnings.
