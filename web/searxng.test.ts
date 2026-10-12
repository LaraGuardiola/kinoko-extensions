import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "./searxng.ts";
import { LOCAL, dockerRun, searxng, settings } from "./searxng.ts";

const home = mkdtempSync(join(tmpdir(), "kinoko-searxng-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const webJson = join(home, ".kinoko", "web.json");
const saved = async (): Promise<Record<string, unknown>> => (await Bun.file(webJson).json().catch(() => ({}))) as Record<string, unknown>;

/** A computer with Docker (and maybe Podman) in some state, and a SearXNG that answers after `upAfter` looks. */
function fake(opts: { docker?: boolean; info?: { code: number; out: string }; podman?: boolean; exists?: boolean; upAfter?: number; platform?: NodeJS.Platform; selinux?: boolean }): Host & { ran: string[] } {
  const ran: string[] = [];
  let looks = 0;
  const installed = { docker: opts.docker ?? true, podman: opts.podman ?? false };
  return {
    ran,
    home,
    platform: opts.platform ?? "linux",
    selinux: opts.selinux ?? false,
    which: (program) => (installed[program as keyof typeof installed] ? `/usr/bin/${program}` : null),
    sleep: async () => undefined,
    probe: async (url) => (url === LOCAL && opts.upAfter !== undefined && ++looks > opts.upAfter ? "json" : "nothing answers there"),
    run: async (cmd) => {
      ran.push(cmd.slice(0, 3).join(" "));
      if (cmd[1] === "info") return cmd[0] === "docker" ? (opts.info ?? { code: 0, out: "27.0" }) : { code: 0, out: "5.2" };
      if (cmd[1] === "inspect") return opts.exists ? { code: 0, out: "exited" } : { code: 1, out: "no such object" };
      return { code: 0, out: "abc123" };
    },
  };
}

beforeEach(() => rmSync(join(home, ".kinoko"), { recursive: true, force: true }));

describe("/searxng", () => {
  test("not set up: says what it is for and how", async () => {
    expect(await searxng("", fake({}))).toContain("/searxng setup runs your own in Docker, on this computer only");
  });

  test("setup with Docker usable: settings written, the container run, web_search told; web.json's other keys kept, 0600", async () => {
    mkdirSync(join(home, ".kinoko"), { recursive: true });
    writeFileSync(webJson, JSON.stringify({ tavily: "tvly-x" }));
    const h = fake({ upAfter: 3 });
    const done = await searxng("setup", h);
    expect(done).toContain(`SearXNG is ready at ${LOCAL} (docker)`);
    expect(done).toContain("`!sudo systemctl enable docker`");
    expect(h.ran).toEqual(["docker info --format", "docker inspect -f", "docker run -d"]);
    expect(await saved()).toEqual({ tavily: "tvly-x", searxng: LOCAL });
    expect(statSync(webJson).mode & 0o777).toBe(0o600);
    const yml = await Bun.file(join(home, ".kinoko", "searxng", "settings.yml")).text();
    expect(yml).toContain("use_default_settings: true");
    expect(yml).toMatch(/secret_key: "[0-9a-f]{64}"/);
    expect(yml).toContain("    - json");
    // A stopped container is started, not run again.
    const again = fake({ upAfter: 0, exists: true });
    again.probe = async () => "nothing answers there";
    expect(await searxng("setup", again)).toContain("SearXNG started but nothing answers there yet");
    expect(again.ran).toEqual(["docker info --format", "docker inspect -f", "docker start kinoko-searxng"]);
  });

  test("setup when Docker refuses this user: the exact sudo command, run once", async () => {
    const out = await searxng("setup", fake({ info: { code: 1, out: "permission denied while trying to connect to the docker API" } }));
    const script = join(home, ".kinoko", "searxng", "start.sh");
    expect(out).toContain(`!sudo sh ${script}`); // one short line to paste
    expect(out).toContain("or install Podman");
    const sh = await Bun.file(script).text();
    expect(sh).toContain(dockerRun(home).join(" "));
    expect(sh).toContain("-p 127.0.0.1:8888:8080 -e FORCE_OWNERSHIP=false");
    expect(sh).toContain(`${join(home, ".kinoko", "searxng")}:/etc/searxng`);
    expect(statSync(script).mode & 0o777).toBe(0o755);
    expect(await saved()).toEqual({});
  });

  test("nothing to run it: what to do, for this system", async () => {
    const linux = await searxng("setup", fake({ docker: false }));
    expect(linux).toContain("Neither Docker nor Podman is installed");
    expect(linux).toContain("`!sudo pacman -S podman`");
    expect(linux).toContain("/searxng use <url>");
    const desktop = [await searxng("setup", fake({ docker: false, platform: "darwin" })), await searxng("setup", fake({ docker: false, platform: "win32" }))];
    for (const out of desktop) {
      expect(out).toContain("install Docker Desktop (https://www.docker.com/products/docker-desktop/)");
      expect(out).not.toContain("sudo");
    }
    expect(await searxng("setup", fake({ info: { code: 1, out: "Cannot connect to the Docker daemon" } }))).toContain("`!sudo systemctl enable --now docker`");
    expect(await searxng("setup", fake({ info: { code: 1, out: "Cannot connect" }, platform: "darwin" }))).toContain("start Docker Desktop");
  });

  test("Podman when Docker cannot: run as the user, no sudo; :Z only with SELinux; how it survives a reboot", async () => {
    const h = fake({ info: { code: 1, out: "permission denied" }, podman: true, upAfter: 2, selinux: true });
    const out = await searxng("setup", h);
    expect(out).toContain(`SearXNG is ready at ${LOCAL} (podman)`);
    expect(out).toContain("podman-restart.service");
    expect(h.ran).toEqual(["docker info --format", "podman info --format", "podman inspect -f", "podman run -d"]);
    expect(dockerRun(home, "podman", true)).toContain(`${join(home, ".kinoko", "searxng")}:/etc/searxng:Z`);
    expect(dockerRun(home, "podman", false)).toContain(`${join(home, ".kinoko", "searxng")}:/etc/searxng`);
    expect(dockerRun(home, "docker", true)).toContain(`${join(home, ".kinoko", "searxng")}:/etc/searxng`);
    // Only Podman installed: the same.
    const only = fake({ docker: false, podman: true, upAfter: 2 });
    expect(await searxng("setup", only)).toContain("(podman)");
  });

  test("one already answering is just saved; status then says it is ready", async () => {
    const h = fake({ upAfter: 0 });
    expect(await searxng("setup", h)).toContain("SearXNG is ready");
    expect(h.ran).toEqual([]);
    expect(await searxng("", h)).toBe(`SearXNG is ready at ${LOCAL}: web_search asks it first.`);
  });

  test("use: a URL that answers JSON is saved; anything else is not", async () => {
    const h = fake({});
    h.probe = async (url) => (url === "http://nas.local:8080" ? "json" : "it answers, but its JSON format is off (search: formats: in settings.yml)");
    expect(await searxng("use nope", h)).toContain("needs a URL");
    expect(await searxng("use http://other:1", h)).toContain("Not saved: at http://other:1 it answers, but its JSON format is off");
    expect(await searxng("use http://nas.local:8080/", h)).toContain("SearXNG at http://nas.local:8080");
    expect(await saved()).toEqual({ searxng: "http://nas.local:8080" });
  });

  test("remove: web_search forgets it and the container goes", async () => {
    mkdirSync(join(home, ".kinoko"), { recursive: true });
    writeFileSync(webJson, JSON.stringify({ searxng: LOCAL, exa: "e" }));
    const h = fake({});
    expect(await searxng("remove", h)).toContain("its container is gone");
    expect(h.ran).toContain("docker rm -f");
    expect(await saved()).toEqual({ exa: "e" });
  });

  test("the settings: SearXNG's defaults, JSON on, no limiter", () => {
    expect(settings("ab")).toContain('secret_key: "ab"');
    expect(settings("ab")).toContain("limiter: false");
  });
});
