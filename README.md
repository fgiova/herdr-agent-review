# Agent Review — a Herdr mod

GitLab-style code review of the uncommitted changes in a git repo, made for reviewing what a Claude Code agent just wrote. A side panel lists the changed files as a folder tree; a pane next to your terminals shows a side-by-side diff with word-level highlights, inline comment threads and a "Viewed" checkbox per file, which folds the files you have checked, like on GitLab. "Send review" sends every unsent comment to the space's Claude Code agent as one message, and the agent's replies show up under the same lines.

![Agent Review](preview.png)

## Requirements

- [Herdr](https://herdr.dev) desktop app.
- `git` and a POSIX `sh` with `xargs` on the machine the repo is on (this one, or a machine added to Herdr).
- A Claude Code agent running in the same Herdr space, to receive the review.
- `jq` on the agent's machine: the agent uses it to post its replies.

## What it runs

Read this before installing. The mod:

- runs `git`, `sh`, `xargs`, `herdr-app do …` (to open its diff pane) and `hc send` (to send the review to the agent);
- reads and empties `<repo>/.git/herdr-review.jsonl`, the file the agent appends its replies to;
- stores comments and "Viewed" marks in Herdr's shared state (`~/.config/herdr-app/shared.json`);
- makes no network requests.

## Install

### With your Herdr agent

In Herdr, ask an agent: *"Install the Herdr mod from https://github.com/fgiova/herdr-agent-review"*. Herdr's `AGENTS.md` tells it how to copy the mod, check it and add it to your layout.

### By hand

1. Copy the mod into Herdr's home. If you already have a mod called `agent-review`, pick another folder name.

   ```sh
   git clone https://github.com/fgiova/herdr-agent-review.git /tmp/herdr-agent-review
   cp -R /tmp/herdr-agent-review/mods/agent-review ~/.config/herdr-app/mods/agent-review
   herdr-app check ~/.config/herdr-app/mods/agent-review
   ```

2. Add the panel to your layout. Herdr's shipped layouts are read-only, so if you are on the default `main` layout, clone it first (this also switches to the clone):

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"my-main"}'
   ```

   In `~/.config/herdr-app/layouts/my-main.json`, find the `panel-body` stack (it holds the Files and Changes panels) and add a third child:

   ```json
   { "id": "agent-review", "type": "block", "content": { "mod": "agent-review" } }
   ```

   Then run `herdr-app status`: the `errors` list must be empty (a broken layout is reported in `layouts/my-main.error`).

3. Show the panel:

   ```sh
   herdr-app do layout.select '{"stack":"panel-body","child":"agent-review"}'
   herdr-app do layout.show --id panel
   ```

4. Optional: a key to toggle the panel. Add it to `~/.config/herdr-app/keys.json`:

   ```json
   { "global": { "cmd-shift-r": "layout.toggle:panel" } }
   ```

   It toggles whichever panel was shown last (Files, Changes or Agent Review).

## Use

1. In a space whose terminal is inside a git repo with uncommitted changes, show the Agent Review panel and click **Open diff**: the diff opens as a pane, zoomed and focused.
2. Tick **Viewed** at the right of a file's header to fold it and mark it in the panel. Click elsewhere on a header to fold or unfold that file.
3. Click a line to comment on it; `cmd-enter` saves, `esc` cancels. Right-click comments on the side under the pointer.
4. Click a comment to select it: `r` replies, `e` edits, `d` deletes.
5. **Send review (N)** sends all unsent comments to the space's Claude Code agent. When the space has several, pick one from the chips in the panel footer.
6. The agent replies by appending a line to `.git/herdr-review.jsonl` (the message includes the exact `jq` command); replies appear under their threads within seconds.
7. **Clear sent** removes the threads you sent and the agent answered.

Comments and "Viewed" marks are kept per repo and survive restarts. A file's "Viewed" mark clears when its diff changes.

## Limits

- Repos on another machine refresh every 10 seconds instead of on file changes.
- Up to 1500 diff rows per file and 4000 characters per line. Word highlighting is off for lines with more than 400 tokens per side.
- File paths that git quotes (unusual characters) aren't parsed.
- Comments are re-anchored by exact text match: after an edit, threads whose line changed are listed at the end of their file.

## Update

Herdr doesn't update mods by itself. Each version is a [GitHub release](https://github.com/fgiova/herdr-agent-review/releases) with its notes, and its number is in `mods/agent-review/mod.json` (`"version"`). To hear about new ones, use **Watch → Custom → Releases** on this repository.

To update, replace the mod's files in place. Herdr reloads the mod at once; your layout, keys, comments and Viewed marks stay as they are.

```sh
git clone https://github.com/fgiova/herdr-agent-review.git /tmp/herdr-agent-review
cp /tmp/herdr-agent-review/mods/agent-review/* ~/.config/herdr-app/mods/agent-review/
herdr-app check ~/.config/herdr-app/mods/agent-review
```

Or ask your Herdr agent: *"Update my installed agent-review mod in place from https://github.com/fgiova/herdr-agent-review"*. Say "in place": by default an agent installs a mod under a new name rather than overwrite one you have.

## Uninstall

Remove `~/.config/herdr-app/mods/agent-review`, the `agent-review` block from your layout and the key from `keys.json`.

## Development

`node mods/agent-review/diff.js` runs the self-test of the diff parser; it prints `ok`. [`RECIPE.md`](RECIPE.md) describes the mod in full, so it can be rebuilt from scratch.

## License

[MIT](LICENSE)
