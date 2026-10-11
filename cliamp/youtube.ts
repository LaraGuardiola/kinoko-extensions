// YouTube search through yt-dlp: real links for a query, so the model never guesses a video id.

export interface Video {
  url: string;
  title: string;
  seconds: number;
}

export type YouTube = (query: string, signal: AbortSignal) => Promise<Video[]>;

export const searchYouTube: YouTube = async (query, signal) => {
  let proc;
  try {
    proc = Bun.spawn(["yt-dlp", "--flat-playlist", "--no-warnings", "--print", "%(id)s\t%(title)s\t%(duration)s", `ytsearch5:${query}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    });
  } catch {
    throw new Error("yt-dlp is not installed (it finds and plays YouTube videos)");
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || "yt-dlp could not search YouTube");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", title = "", duration = ""] = line.split("\t");
      return { url: `https://www.youtube.com/watch?v=${id}`, title: title || id, seconds: Number(duration) || 0 };
    });
};

/** "3:40" */
export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
