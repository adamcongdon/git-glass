# Git Glass

A local-first PWA that surfaces repository status, triages feedback into GitHub/GitLab issues, and scores repo activity — all running as a single Bun process bound to `127.0.0.1:7777`.

## Features

**Feedback** — paste text or a screenshot; AI triages it and opens a GitHub or GitLab issue with the right labels, repo, and (for GitHub) an attached image.

**Repos** — depth-first scan of configured paths; shows branch, dirty state, ahead/behind, and last-commit age. Supports pull, push, open in VS Code, reveal in Finder, AI commit message, AI triage, and safe delete.

**Leaderboard** — composite activity score (`commits×10 + filesChanged + 0.05×lines ± recency decay`) across all scanned repos for 7d / 30d / 90d / all-time windows.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [gh CLI](https://cli.github.com) authenticated (`gh auth login`) — used for GitHub token discovery; no tokens are stored by Git Glass
- macOS (LaunchAgent install path; the server itself is cross-platform)

## Setup

```bash
git clone <repo-url> feedback-tool
cd feedback-tool
bun install
cp config-example.json ~/.config/feedback-tool/config.json
# Edit config.json — set scanPaths at minimum
```

**Config file** (`~/.config/feedback-tool/config.json`):

```json
{
  "scanPaths": ["/Users/you/dev", "/Users/you/projects"],
  "scanDepth": 3,
  "port": 7777,
  "github": {
    "copilotAccount": "your-gh-username",
    "defaultAccount": "your-gh-username"
  }
}
```

For GitLab, add per-host PATs (requires `api` scope):

```json
{
  "gitlab": {
    "tokens": {
      "gitlab.example.com": "glpat-..."
    }
  }
}
```

## Running

```bash
bun run start        # one-shot
bun run dev          # with --watch reload
```

Open `http://127.0.0.1:7777`.

## Install as a macOS LaunchAgent

Runs automatically at login; `KeepAlive=true` restarts on crash.

```bash
./install.sh     # installs or refreshes the LaunchAgent
./uninstall.sh   # removes the LaunchAgent (config and logs preserved)
```

The dashboard self-updates via **Settings → Update** (`git pull --ff-only` in its own checkout) and restarts cleanly via **Settings → Restart**.

## Tests

```bash
bun test                                   # all tests
bun test tests/triage.test.ts              # single file
bun test -t "parseAheadBehind"             # single test name
```

Tests are pure-function focused (parsers, validators, scoring math) and don't boot the server.

## Architecture

```
index.ts          Hono server — routes + CSRF guard (127.0.0.1 only)
lib/
  config.ts       Zod-validated config, atomic write, token redaction
  scanner.ts      Repo discovery (depth-capped walk, skips node_modules/.git)
  gitStatus.ts    Read-only git ops — runGit(), pMap(), validateRepoPath()
  gitOps.ts       Mutations — pull/push/delete/openVSCode (triple-validated)
  triage.ts       AI triage via GitHub Copilot Chat API (claude-haiku-4.5)
  inference.ts    AI commit messages via PAI Inference.ts (optional)
  leaderboard.ts  Scoring + in-memory cache keyed by HEAD SHA
  github.ts       Issue creation, screenshot upload to .github/issue-assets/
  gitlab.ts       Issue creation via per-host PAT
  gh.ts           gh CLI wrapper — multi-account token discovery
  remoteUrl.ts    SSH/HTTPS remote → browser URL (mirrored in app.html)
public/
  app.html        Single-file SPA — no build step
  sw.js           Service worker — cache-first shell, network-only for /api/*
```

No build step. `public/app.html` is hand-written HTML with inline scripts. Bump `CACHE_VERSION` in `sw.js` on every change to `app.html`.

## Auth model

| Action | Token source |
|---|---|
| AI triage | GitHub Copilot token via `gh auth token -u <copilotAccount>` |
| Create GitHub issue | `ownerAccounts[owner]` → `defaultAccount` → `gh auth token` |
| Create GitLab issue | `config.gitlab.tokens[host]` (persisted PAT) |
| AI commit / repo triage | PAI `Inference.ts` — no token managed here |

## Security

- Binds to `127.0.0.1` only.
- Every mutating endpoint checks `Origin`/`Referer` (CSRF guard).
- All path inputs go through `validateRepoPath()` — realpath + scanPaths containment + rejects `..`.
- `/api/config` GET returns redacted config (GitLab tokens stripped; only host list exposed).
- `deleteRepo` triple-validates before `rm -rf`.
