# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project identity

User-facing name: **Git Glass**. Package/directory name remains `feedback-tool` so the existing PWA install (LaunchAgent label `com.feedback-tool`, manifest scope, localStorage keys, etc.) keeps working. Don't rename the package, the install paths, or the legacy localStorage keys (`lastRepo`, `lastRepoName`, `install_dismissed`). New keys use the `glass.` prefix.

## Common commands

```bash
bun install              # install deps
bun run start            # run the server (index.ts → http://127.0.0.1:7777)
bun run dev              # same, with --watch reload
bun test                 # run all tests
bun test tests/triage.test.ts          # single file
bun test -t "parseAheadBehind"         # single test name pattern
./install.sh             # install/refresh the macOS LaunchAgent (runs at login, KeepAlive=true)
./uninstall.sh           # remove the LaunchAgent (preserves config + logs)
```

Runtime is Bun (uses `Bun.spawn`, `Bun.serve`, `bun-types` in tsconfig). Don't introduce Node-only APIs without checking the Bun equivalent.

## Architecture — single-process Hono server + static SPA

This is a one-binary local web app. `index.ts` boots a Hono server bound to `127.0.0.1` that serves both a JSON API and a single static HTML file. There is **no build step** — `public/app.html` is hand-written HTML with two inline `<script>` blocks; the service worker handles offline caching.

Four views, all in [public/app.html](public/app.html):
- **Feedback** — paste text/screenshot → AI triages → opens a GitHub or GitLab issue.
- **Repos** — depth-1 scan of `scanPaths`, shows status (branch / dirty / ahead-behind / stale), supports pull/push/open-in-VSCode/reveal/ignore/delete and AI commit message + AI triage.
- **Issues** — read-only GitHub + GitLab issue list for local clones. Modes: Mine (assigned/authored/mentioned) · All local · This repo. Filters: state, host, repo, labels, author, assignee, updated presets. Opens issues on the host; 90s memory cache + manual refresh. Backed by [lib/issues.ts](lib/issues.ts) + `GET /api/issues`.
- **Leaderboard** — composite activity score across all scanned repos for a 7d/30d/90d/all window.

Server-side responsibilities split across [lib/](lib/):
- [lib/config.ts](lib/config.ts) — Zod-validated config persisted at `~/.config/feedback-tool/config.json` with 0600 perms via atomic tmp+rename. Module-level `_cache` is invalidated on write. `redactConfig()` strips GitLab tokens before returning over `/api/config`. `writeConfig()` merges deeply; for `gitlab.tokens`, an empty-string value **deletes** that host entry (no separate DELETE endpoint).
- [lib/scanner.ts](lib/scanner.ts) — recursive walk for the Feedback view (depth up to 3, hard cap 500 results, skips `node_modules`, `.git`, etc.). Parses `.git/config` directly rather than shelling out. Also exports `parseRemoteUrl` (SSH/HTTPS).
- [lib/gitStatus.ts](lib/gitStatus.ts) — read-only git ops for the Repos/Leaderboard views. `runGit()` is the only `git` shell-out — it pipes a 10s timeout and disables credential prompts (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`). `pMap()` is the bounded-concurrency primitive (default 8). `validateRepoPath()` is the **security gate** for any path coming from a request body: realpath-resolves and requires `startsWith(scanPath + "/")`. Use it before every mutating git op.
- [lib/gitOps.ts](lib/gitOps.ts) — repo mutations (pull/push/delete/openVSCode/revealInFinder). `deleteRepo` triple-validates: `validateRepoPath` → `lstat(resolved).isDirectory()` → `lstat(.git).isDirectory()`. Don't loosen these gates.
- [lib/github.ts](lib/github.ts) / [lib/gitlab.ts](lib/gitlab.ts) — issue creation. GitHub additionally uploads an attached screenshot to `.github/issue-assets/` on `main` (then `master`) and embeds the resulting URL. 422 (missing label) is silently retried without labels.
- [lib/gh.ts](lib/gh.ts) — shells out to `gh auth status` / `gh auth token -u <account>` to discover multi-account setups and fetch tokens on demand. Tokens are **not** persisted by Git Glass; the source of truth is the `gh` CLI keychain.
- [lib/triage.ts](lib/triage.ts) — calls the **GitHub Copilot Chat API** (`api.githubcopilot.com/chat/completions`, model `claude-haiku-4.5`) with the user's gh token. Image attachments use OpenAI-style `image_url` content parts. The "suggested_repo" field is constrained to the list the client sent, with a server-side guard that coerces unknown values to `null`.
- [lib/inference.ts](lib/inference.ts) — wraps `~/.claude/PAI/Tools/Inference.ts` for AI commit messages and AI repo triage. Returns a discriminated `{ status: "ok" | "unavailable" | "timeout" | "error" }`. When PAI isn't installed, callers must return HTTP 503, not crash. The PATH is augmented with `/opt/homebrew/bin:/usr/local/bin` because launchd starts the process with a minimal PATH.
- [lib/leaderboard.ts](lib/leaderboard.ts) — scores each repo with `commits*10 + filesChanged*1 + (additions+deletions)*0.05 + 50*exp(-daysSinceLast/halfLife)`. Cached in-memory keyed by `${windowLabel}::${repoPath}::${HEAD_sha}`; the cheap `git rev-parse HEAD` precedes the expensive `git log --numstat`. Also reads month-to-date Claude API spend from `$PAI_DIR/MEMORY/STATE/usage-cache.json` keyed by `repoPath.replace(/[/.]/g, "-")`.
- [lib/issues.ts](lib/issues.ts) — discovers local remotes, lists issues via GitHub Search (three queries: assignee/author/mentions `@me`) or per-repo list, and GitLab project/issues + assigned/created/todos. Identity from `ownerAccounts` → `defaultAccount` → `gh` / `gitlab.tokens[host]`. Soft-fails per source; 90s in-memory cache; paginate 50.
- [lib/remoteUrl.ts](lib/remoteUrl.ts) — `remoteToWebUrl` converts a git remote (SSH/HTTPS/ssh://) to a browser URL. **This function is duplicated** verbatim in [public/app.html](public/app.html) as `glassRemoteToWebUrl` (line ~2636) because the SPA has no build step. Keep both in sync.

## Auth model

| Surface | Auth source |
|---|---|
| AI triage of pasted feedback | GitHub Copilot OAuth token from `config.github.copilotAccount` via `gh auth token -u …` |
| Creating GitHub issues | `config.github.ownerAccounts[owner]` → `config.github.defaultAccount` → `gh auth token -u …` |
| Creating GitLab issues | `config.gitlab.tokens[host]` (per-host PAT with `api` scope) |
| AI commit msg / AI repo triage | Shells out to `~/.claude/PAI/Tools/Inference.ts` — no token managed here |

GitLab tokens are persisted in `config.json` (mode 0600); GitHub tokens are not — they're retrieved fresh from `gh` per request.

## Security model (don't regress these)

The server binds to `127.0.0.1` only, but a malicious webpage in another tab can still make a cross-origin POST with `Content-Type: text/plain` (no preflight). Every mutating endpoint in [index.ts](index.ts) starts with:

```ts
const csrf = sameOriginGuard(c);
if (csrf) return csrf;
```

`sameOriginGuard` rejects requests whose `Origin` or `Referer` points to a non-loopback hostname; missing both is treated as CLI usage and allowed. **Add this guard to every new mutating route.**

Other invariants:
- All path-bearing request bodies go through `validateRepoPath()` (realpath + scanPaths containment + rejects `..`).
- `SELF_REPO_DIR` for `/api/update` is captured at module load via `resolvePath(import.meta.dir)` so it can't be redirected by config or request body — leave that pattern alone.
- `/api/config` GET returns `RedactedConfig`, which omits `gitlab.tokens` (only the host list is exposed). Don't return the raw config.
- Hostnames in `gitlab.tokens` are validated with an RFC 1123 regex; repo names in `/api/triage` must match `owner/repo`. Keep these schemas tight.

## PWA + service worker

[public/sw.js](public/sw.js) does cache-first for the app shell, network-only for `/api/*`. **Bump `CACHE_VERSION` (currently `'v10'`) on every change to [public/app.html](public/app.html)** — otherwise users get a stale shell on soft-refresh and won't see your UI changes. Static-asset routes in `index.ts` (`/manifest.json`, `/sw.js`, `/icons/:file`) are served explicitly above the catch-all `app.get("*")` that returns `app.html`; preserve that ordering.

## Server self-management

The dashboard updates itself in-place via `/api/update` (runs `git pull --ff-only` in its own checkout with a 30s timeout) and `/api/restart` (`process.exit(0)` after 300ms; launchd's `KeepAlive=true` brings it back). Don't add long-running async work without considering that the process can be killed at any time.

## Tests

`bun test` runs all of [tests/](tests/). Tests are pure-function focused (parsers, validators, redactors, scoring math) — they exercise the lib modules directly without booting the server. When adding logic to a `lib/*.ts` file, prefer extracting the pure piece (parser, predicate, formula) and unit-testing it the same way the existing tests do.
