// YouTube through yt-dlp: real links for a query (videos, or playlists such as an album or a
// soundtrack) and the videos of a playlist, so the model never guesses a link.

export interface Video {
  url: string;
  title: string;
  seconds: number;
}

export interface YouTube {
  videos: (query: string, signal: AbortSignal) => Promise<Video[]>;
  /** Playlists for a query: an album, a soundtrack, an artist's songs. */
  playlists: (query: string, signal: AbortSignal) => Promise<Video[]>;
  /** The videos of a playlist, in its order. */
  playlist: (url: string, signal: AbortSignal) => Promise<Video[]>;
}

/** One entry per line of what yt-dlp lists for `target`, without downloading anything. */
async function list(target: string, signal: AbortSignal, max: number): Promise<Video[]> {
  let proc;
  try {
    proc = Bun.spawn(["yt-dlp", "--flat-playlist", "--no-warnings", "--playlist-items", `1-${max}`, "--print", "%(url)s\t%(title)s\t%(duration)s", target], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
  } catch {
    throw new Error("yt-dlp is not installed (it finds and plays YouTube videos)");
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || "yt-dlp could not reach YouTube");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [url = "", title = "", duration = ""] = line.split("\t");
      return { url, title: title || url, seconds: Number(duration) || 0 };
    });
}

export const youtube: YouTube = {
  videos: (query, signal) => list(`ytsearch5:${query}`, signal, 5),
  // YouTube's own search, filtered to playlists.
  playlists: (query, signal) => list(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAw%3D%3D`, signal, 5),
  playlist: (url, signal) => list(url, signal, 100),
};

/** A link to a YouTube playlist (not one video of it). */
export const isPlaylist = (url: string): boolean => /^https?:\/\/(www\.|music\.)?youtube\.com\/playlist\?/.test(url);

/** "3:40"; "" when YouTube did not say. */
export const clock = (seconds: number): string => (seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` : "");

const line = (v: Video): string => `  ${v.title}${v.seconds ? ` (${clock(v.seconds)})` : ""} ${v.url}`;

/** The other results, with what the model can do with them. */
export const otherResults = (found: Video[], what: string): string => (found.length > 0 ? `\nother ${what} (queue one with its link to add it after, play to switch to it):\n${found.map(line).join("\n")}` : "");
