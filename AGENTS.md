# kinoko-extensions: agent rules

- One extension per folder: `index.ts` (default export taking `Kinoko`), `index.test.ts`,
  `package.json` with a `description`. Its own runtime `dependencies` go there, nowhere else.
- A folder is copied alone into `~/.kinoko/ext/<name>/`: import from outside it only with
  `import type` from `../api.ts`. `api.ts` mirrors kinoko's `src/ext.ts` and `src/types.ts`:
  change it when kinoko's extension API changes.
- Every async operation honors an AbortSignal; nothing blocks the event loop; a handler never throws
  into kinoko.
- Works on Linux, macOS and Windows unless its package.json says otherwise (`"os"`); a tool that
  cannot work somewhere is not registered there.
- `bun run check` passes with zero warnings before a commit. New extension: add it to README's table.
