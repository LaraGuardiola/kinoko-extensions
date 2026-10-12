// /searxng: your own SearXNG for web_search, set up from kinoko, because search pages turn scripts
// away and the free APIs want a card. Optional: nothing is downloaded until `/searxng setup`, which
// runs it on this computer only (127.0.0.1:8888) with Docker or Podman (Podman needs no sudo), its
// settings in ~/.kinoko/searxng. What it says to do next fits the system: Linux, macOS, Windows.
//   /searxng          where it stands and what to do next
//   /searxng setup    settings written, the container started, web_search told (web.json)
//   /searxng use URL  a SearXNG of yours elsewhere (JSON format on)
//   /searxng remove   the container gone, web_search back to the pages

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./engines.ts";

export const LOCAL = "http://127.0.0.1:8888";
const NAME = "kinoko-searxng";
const IMAGE = "docker.io/searxng/searxng:latest";

/** How a command ran: its exit code and what it said. */
export type Run = (cmd: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

const run: Run = async (cmd, timeoutMs = 30_000) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", signal: AbortSignal.timeout(timeoutMs) });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}`.trim() };
  } catch (e) {
    return { code: -1, out: e instanceof Error ? e.message : String(e) };
  }
};

/** Docker, or Podman: the same commands. */
export type Engine = "docker" | "podman";

export interface Host {
  home: string;
  run: Run;
  /** Where a program is, or null when it is not installed. */
  which: (program: string) => string | null;
  platform: NodeJS.Platform;
  /** SELinux enforcing: Podman's volume then needs relabelling (:Z). */
  selinux: boolean;
  /** Asks a SearXNG: "json" when its JSON format answers, else why not. */
  probe: (url: string) => Promise<"json" | string>;
  sleep: (ms: number) => Promise<void>;
}

async function probe(url: string): Promise<"json" | string> {
  try {
    const res = await fetch(`${url}/search?q=kinoko&format=json`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 403) return "it answers, but its JSON format is off (search: formats: in settings.yml)";
    if (res.status !== 200) return `it answers HTTP ${res.status}`;
    const data = (await res.json().catch(() => undefined)) as { results?: unknown } | undefined;
    return Array.isArray(data?.results) ? "json" : "it answers, but not with SearXNG's JSON";
  } catch {
    return "nothing answers there";
  }
}

const realHost = (): Host => ({
  home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  run,
  which: (program) => Bun.which(program),
  platform: process.platform,
  selinux: existsSync("/sys/fs/selinux/enforce"),
  probe,
  sleep: (ms) => Bun.sleep(ms),
});

/** SearXNG's defaults, plus the JSON format web_search reads; no rate limiter (it is yours alone). */
export function settings(secret: string): string {
  return [
    "# kinoko's SearXNG (made by /searxng setup): SearXNG's defaults, plus the JSON format web_search reads.",
    "use_default_settings: true",
    "server:",
    `  secret_key: "${secret}"`,
    "  limiter: false",
    "  image_proxy: false",
    "search:",
    "  formats:",
    "    - html",
    "    - json",
    "",
  ].join("\n");
}

const dirOf = (home: string): string => join(home, ".kinoko", "searxng");

/** The command that starts it: this computer only, settings ours, its cache a volume. */
export function dockerRun(home: string, engine: Engine = "docker", selinux = false): string[] {
  const relabel = engine === "podman" && selinux ? ":Z" : "";
  return [engine, "run", "-d", "--name", NAME, "--restart", "unless-stopped", "-p", "127.0.0.1:8888:8080", "-e", "FORCE_OWNERSHIP=false", "-v", `${dirOf(home)}:/etc/searxng${relabel}`, "-v", `${NAME}-cache:/var/cache/searxng`, IMAGE];
}

/** ~/.kinoko/web.json with `searxng` set (or removed), what else it holds kept. */
async function saveUrl(home: string, url: string | undefined): Promise<void> {
  const file = join(home, ".kinoko", "web.json");
  const data = (await Bun.file(file).json().catch(() => ({}))) as Record<string, unknown>;
  if (url === undefined) delete data.searxng;
  else data.searxng = url;
  await mkdir(join(home, ".kinoko"), { recursive: true });
  await Bun.write(file, `${JSON.stringify(data, null, 2)}\n`);
  await chmod(file, 0o600);
}

/** What runs containers here: a usable Docker or Podman, or what stands in the way of Docker. */
async function engineState(h: Host): Promise<{ ok: Engine } | { blocked: "missing" | "denied" | "down" }> {
  let docker: "missing" | "denied" | "down" = "missing";
  if (h.which("docker") !== null) {
    const info = await h.run(["docker", "info", "--format", "{{.ServerVersion}}"], 10_000);
    if (info.code === 0) return { ok: "docker" };
    docker = /permission denied/i.test(info.out) ? "denied" : "down";
  }
  // Podman runs as the user, no daemon, no sudo: just as good.
  if (h.which("podman") !== null && (await h.run(["podman", "info", "--format", "{{.Version.Version}}"], 10_000)).code === 0) return { ok: "podman" };
  return { blocked: docker };
}

const DESKTOP = "Docker Desktop (https://www.docker.com/products/docker-desktop/)";

/** What to do when nothing can run it, for this system. */
function advice(h: Host, blocked: "missing" | "denied" | "down", script: string): string {
  const linux = h.platform === "linux";
  const other = "Or point kinoko at a SearXNG you already run: /searxng use <url>.";
  if (blocked === "missing") {
    return linux
      ? `Neither Docker nor Podman is installed. Podman is the simpler one (no sudo afterwards): install it from your distribution (Arch \`!sudo pacman -S podman\`, Debian/Ubuntu \`!sudo apt install podman\`, Fedora \`!sudo dnf install podman\`), then /searxng setup.\n${other}`
      : `Docker is not installed: install ${DESKTOP}, start it, then /searxng setup.\n${other}`;
  }
  if (blocked === "down") {
    return linux ? `Docker is installed but not running: \`!sudo systemctl enable --now docker\`, then /searxng setup.\n${other}` : `Docker is installed but not running: start Docker Desktop, then /searxng setup.\n${other}`;
  }
  return [
    "Docker refuses this user. Either start it once with sudo:",
    `  !sudo sh ${script}`,
    "and so it comes back after a reboot, `!sudo systemctl enable docker`;",
    "or install Podman, which runs it as you without sudo (`!sudo pacman -S podman`, `apt`, `dnf`...).",
    "Then /searxng setup once more: it finds it and tells web_search.",
  ].join("\n");
}

/** After a reboot: what brings it back. */
function reboot(h: Host, engine: Engine): string {
  if (engine === "podman") return "After a reboot Podman starts it if `!systemctl --user enable podman-restart.service` was run once (else /searxng setup starts it again)";
  if (h.platform !== "linux") return "It comes back whenever Docker Desktop runs";
  return "It comes back with Docker after a reboot (`!sudo systemctl enable docker` if Docker does not start with the computer)";
}

export async function status(h: Host = realHost()): Promise<string> {
  const file = (await readConfig(h.home)).searxng;
  const url = process.env.SEARXNG_URL || file;
  if (url) {
    const answer = await h.probe(url);
    return answer === "json" ? `SearXNG is ready at ${url}: web_search asks it first.` : `web_search is set to use SearXNG at ${url}, but ${answer}. /searxng setup to start kinoko's, or /searxng remove.`;
  }
  if ((await h.probe(LOCAL)) === "json") return `A SearXNG answers at ${LOCAL} but web_search does not use it yet: /searxng setup.`;
  return [
    "SearXNG is not set up: web_search reads search pages, which turn kinoko away after a few searches in a row.",
    "/searxng setup runs your own in Docker, on this computer only (free, no key, no limit; Docker downloads its image the first time).",
    "Or /searxng use <url> for one you already have.",
  ].join("\n");
}

export async function setup(h: Host = realHost()): Promise<string> {
  const dir = dirOf(h.home);
  const config = join(dir, "settings.yml");
  if (!(await Bun.file(config).exists())) {
    await mkdir(dir, { recursive: true });
    await Bun.write(config, settings(randomBytes(32).toString("hex")));
  }
  if ((await h.probe(LOCAL)) === "json") {
    await saveUrl(h.home, LOCAL);
    return `SearXNG is ready at ${LOCAL}: web_search asks it first (saved in ~/.kinoko/web.json).`;
  }
  const state = await engineState(h);
  // The command, kept beside the settings: a short line to paste when Docker needs sudo.
  const script = join(dir, "start.sh");
  const engine = "ok" in state ? state.ok : "docker";
  await Bun.write(script, `#!/bin/sh\n# Starts kinoko's SearXNG (made by /searxng setup).\n${dockerRun(h.home, engine, h.selinux).map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a}'`)).join(" ")}\n`);
  await chmod(script, 0o755);
  if (!("ok" in state)) return advice(h, state.blocked, script);
  const existing = await h.run([engine, "inspect", "-f", "{{.State.Status}}", NAME], 10_000);
  const started = existing.code === 0 ? await h.run([engine, "start", NAME], 60_000) : await h.run(dockerRun(h.home, engine, h.selinux), 300_000);
  if (started.code !== 0) return `${engine === "podman" ? "Podman" : "Docker"} could not start SearXNG: ${started.out.split("\n").at(-1) ?? ""}`;
  // It takes a few seconds to answer the first time.
  let answer = await h.probe(LOCAL);
  for (let i = 0; i < 30 && answer !== "json"; i++) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for it to come up, one look at a time
    await h.sleep(1_000);
    // oxlint-disable-next-line no-await-in-loop -- same wait
    answer = await h.probe(LOCAL);
  }
  if (answer !== "json") return `SearXNG started but ${answer} yet: /searxng in a moment to look again (logs: \`!${engine} logs ${NAME}\`).`;
  await saveUrl(h.home, LOCAL);
  return `SearXNG is ready at ${LOCAL} (${engine}): web_search asks it first (saved in ~/.kinoko/web.json). ${reboot(h, engine)}; when it is down, web_search uses the other engines.`;
}

export async function use(url: string, h: Host = realHost()): Promise<string> {
  const clean = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(clean)) return "/searxng use needs a URL, like http://192.168.1.10:8888";
  const answer = await h.probe(clean);
  if (answer !== "json") return `Not saved: at ${clean} ${answer}.`;
  await saveUrl(h.home, clean);
  return `SearXNG at ${clean}: web_search asks it first (saved in ~/.kinoko/web.json).`;
}

export async function remove(h: Host = realHost()): Promise<string> {
  await saveUrl(h.home, undefined);
  const state = await engineState(h);
  if (!("ok" in state)) return `web_search no longer uses SearXNG. To remove the container too: \`!sudo docker rm -f ${NAME}\`.`;
  const gone = await h.run([state.ok, "rm", "-f", NAME], 30_000);
  return `web_search no longer uses SearXNG${gone.code === 0 ? `, and its container is gone (its image stays: \`!${state.ok} rmi ${IMAGE}\` frees it)` : ""}.`;
}

/** `/searxng [setup | use URL | remove]`. */
export function searxng(args: string, h?: Host): Promise<string> {
  const [verb = "", ...rest] = args.trim().split(/\s+/);
  if (verb === "setup") return setup(h);
  if (verb === "use") return use(rest.join(" "), h);
  if (verb === "remove") return remove(h);
  return status(h);
}
