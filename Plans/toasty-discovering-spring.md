# Plan — Merge `git-status-dashboard` into the `feedback-tool` PWA, rebrand as **Glass**

## Context

Two personal devtools live in `~/code/`:
- **feedback-tool** (`~/code/feedback-tool`): Bun + Hono + TypeScript, an installed PWA on `127.0.0.1:7777` that runs at login. UI is a single `public/app.html` state machine. Takes free-form feedback → AI-triages it via the GitHub Copilot API → opens a GitHub/GitLab issue.
- **git-status-dashboard** (`~/code/git-status-dashboard`): Bun + zero-deps + TypeScript, a separate server on `127.0.0.1:3847` installed via `~/Library/LaunchAgents/com.git-status-dashboard.plist`. Grid of repo cards with branch/dirty/ahead-behind/stale status, pull/push/ignore/delete actions, and optional AI commit-message + AI-triage backed by `~/.claude/PAI/Tools/Inference.ts`.

Goal: one **single pane of glass** for all local git work. Keep `feedback-tool` as the running PWA (already installed, launches at login) and absorb `git-status-dashboard` as a second view inside it. Retire the standalone dashboard service. Rebrand user-facing strings to **Glass**; leave the directory name `feedback-tool/` and the Bun package name unchanged so the existing PWA install keeps working.

Confirmed decisions (from interactive review):
1. **Name**: Rebrand the manifest + window title to "Glass". Tab bar reads `[ Feedback ] [ Repos ]`. PWA `start_url` unchanged so the install is preserved.
2. **Config**: Unify on a single `scanPaths`. Feedback view keeps its recursive depth-3 walk; Repos view uses depth-1 (matches the dashboard's existing behavior). One-time manual merge of the two existing config files.
3. **AI**: Keep both paths. Feedback triage stays on Copilot API (image + JSON). Git AI commit msg + repo triage stay on `~/.claude/PAI/Tools/Inference.ts` (text + freeform). Graceful 503 when Inference.ts is missing.
4. **Old project**: Stop the LaunchAgent, then `mv ~/code/git-status-dashboard ~/code/_archived/git-status-dashboard` after smoke test.

---

## Critical files

### New
- `lib/gitStatus.ts` — port of read-only git ops from `git-status-dashboard/server.ts:71-312`: `runGit`, `pMap` (concurrency-8), `validateRepoPath`, `getRepoStatus` (branch / uncommitted / ahead-behind / last-commit / branch refs), `getGitRepos` (depth-1 scan over `scanPaths`, filters `ignoredRepos`).
- `lib/gitOps.ts` — repo mutations in one audited module: `gitPull`, `gitPush`, `pullAllSafe`, `deleteRepo` (rm -rf, must be inside a `scanPaths` entry AND must contain `.git/`).
- `lib/inference.ts` — wrapper for `~/.claude/PAI/Tools/Inference.ts` (port of `checkAIAvailable` + `runInference` from `server.ts:147-185`). `isAvailable(): Promise<boolean>` and `run(systemPrompt, userPrompt, level="fast")`. Returns `null` when unavailable; routes return 503.
- `tests/gitStatus.test.ts` — parsing + scan + ignore logic (see Test cases below).
- `tests/gitOps.test.ts` — delete path validation + pull-all-safe filtering.

### Modified
- `index.ts` — register 12 new `/api/git/*` routes (table below). All mutating routes wrap `sameOriginGuard(c)`. Reuses existing `readConfig()` and error helpers.
- `lib/config.ts` — extend `ConfigSchema` with `ignoredRepos: z.array(z.string()).default([])` and `repos: z.object({ autoRefreshSec: z.number().int().min(0).max(1800).default(0) }).default({})`. Update `RedactedConfig` and `redactConfig()` to surface both. Update `ConfigUpdateSchema` in `index.ts` accordingly.
- `public/app.html`:
  - Wrap existing body content in `<div id="view-feedback">`.
  - Add `<nav id="tabbar">` above with two buttons (`Feedback`, `Repos`) and a settings cog (existing).
  - Append `<div id="view-repos" hidden>` containing: toolbar (refresh, pull-all-safe, auto-refresh select, AI-triage), filter chips (all / uncommitted / ahead-behind / clean / no-remote / branch-issues / stale / errors), repo card grid, ignored-repos drawer, delete-confirm modal, AI-commit-msg modal, AI-triage modal.
  - Add a **second** `<script>` block (still inline, not `type="module"`) for repo-view logic. First block exposes a tiny shared helper bag (`api(path, body)`, `showBanner(msg)`, `state`); second block reads from it.
  - Add `<title>Glass</title>` and update existing header text.
  - All new localStorage keys prefixed `glass.` (`glass.activeView`, `glass.repos.filter`, `glass.repos.autoRefreshSec`). Existing keys (`lastRepo`, `lastRepoName`, `install_dismissed`) stay unprefixed — they are the PWA's installed-state keys.
  - Keyboard: `⌘1` / `⌘2` switch views.
- `public/sw.js` — bump `CACHE_VERSION` from `'v3'` → `'v4'`. Fetch handler is already correct (network-only for `/api/*` covers all new git endpoints; cache-first for shell). No other changes.
- `public/manifest.json` — `name: "Glass"`, `short_name: "Glass"`, `description: "Local git + feedback console"`. Add `shortcuts: [{ name: "Feedback", url: "/?v=feedback" }, { name: "Repos", url: "/?v=repos" }]` so right-click on the dock icon offers both views (the page reads `?v=` once on load and sets `activeView` accordingly, then strips the query). `start_url` stays `/`.

### Not touched
- `lib/scanner.ts` — feedback view's deep walk + remote-URL parsing stays as-is. Repo view uses its own depth-1 scanner in `gitStatus.ts`.
- `lib/triage.ts`, `lib/github.ts`, `lib/gitlab.ts`, `lib/gh.ts` — feedback flow untouched.

### Retired
- `~/code/git-status-dashboard/` — moved to `~/code/_archived/git-status-dashboard/` after smoke test (see cutover step 14).
- `~/Library/LaunchAgents/com.git-status-dashboard.plist` — unloaded and removed via the dashboard's own `uninstall.sh` (cutover step 1).

---

## Backend route map

All routes localhost-only, JSON in/out. Mutating routes require `sameOriginGuard`.

| Method | Path | Purpose | CSRF |
|---|---|---|---|
| GET  | `/api/git/repos`           | Scan + status for all non-ignored repos (depth-1) | No |
| GET  | `/api/git/ignored`         | List ignored repo paths | No |
| POST | `/api/git/ignore`          | Add path to `ignoredRepos` (persists via `writeConfig`) | Yes |
| POST | `/api/git/unignore`        | Remove path from `ignoredRepos` | Yes |
| POST | `/api/git/pull`            | `git pull` in one repo (path-validated) | Yes |
| POST | `/api/git/push`            | `git push` in one repo (path-validated) | Yes |
| POST | `/api/git/pull-all-safe`   | Pull only repos with `behind > 0 && uncommitted === 0 && !error` | Yes |
| POST | `/api/git/open-vscode`     | `code <path>` via Bun.spawn (path-validated) | Yes |
| POST | `/api/git/reveal`          | `open -R <path>` via Bun.spawn (path-validated) | Yes |
| POST | `/api/git/delete`          | `rm -rf` after **double validation** (in `scanPaths` + contains `.git/`) | Yes |
| POST | `/api/git/ai-commit-msg`   | Generate commit message from staged/HEAD diff via Inference.ts; 503 if unavailable | Yes |
| POST | `/api/git/ai-triage`       | Triage actionable repos via Inference.ts; 503 if unavailable | Yes |

Existing routes (`/api/health`, `/api/repos`, `/api/triage`, `/api/issues`, `/api/config`, `/api/gh-accounts`) and static routes (`/manifest.json`, `/sw.js`, `/icons/*`, `/*` → app.html) are unchanged. The dashboard's `/api/update` and `/api/restart` are dropped — feedback-tool runs differently and has no in-app self-update story to inherit.

Reuse: `sameOriginGuard` (`index.ts:38`), `errorResponse` (`index.ts:27`), `readConfig` / `writeConfig` / `redactConfig` (`lib/config.ts`). All path validators MUST go through `validateRepoPath(path, scanPaths)` in `lib/gitStatus.ts` — never trust the client.

---

## Frontend tabs + state

Pseudocode (the actual implementation lives in `app.html`'s new second `<script>` block):

```
state.activeView = localStorage.getItem('glass.activeView') ?? 'feedback'
state.repos = { items: [], filter: 'all', autoRefreshSec: 0, ignored: [], aiTriageOutput: null, deleteTarget: null }

function setActiveView(v) {
  state.activeView = v
  localStorage.setItem('glass.activeView', v)
  document.getElementById('view-feedback').hidden = v !== 'feedback'
  document.getElementById('view-repos').hidden    = v !== 'repos'
  renderTabs()
  if (v === 'repos' && state.repos.items.length === 0) loadRepos()
  if (v === 'repos') startAutoRefresh()
  else stopAutoRefresh()
}

// On load: respect ?v=feedback or ?v=repos (from manifest shortcuts), then strip query.
```

Auto-refresh polls `GET /api/git/repos` on the interval saved in `glass.repos.autoRefreshSec`. Polling **only runs while the Repos view is active** — saves git-CLI churn when the user is in Feedback view.

The existing feedback state machine (`IDLE` / `DRAFT` / `TRIAGING` / `TRIAGED` / `SUBMITTING` / `SUCCESS` / `ERROR`) is untouched. The view-switch toggle sits above it.

---

## Config schema (after extension)

```ts
ConfigSchema = z.object({
  scanPaths:    z.array(z.string().min(1)).default([]),     // unified — feedback uses depth-3, repos uses depth-1
  scanDepth:    z.number().int().min(1).max(10).default(3), // applies only to feedback view's walker
  port:         z.number().int().default(7777),
  github:       { copilotAccount?, defaultAccount?, ownerAccounts },
  gitlab:       { tokens },
  ignoredRepos: z.array(z.string()).default([]),            // NEW — absolute paths the repos view hides
  repos:        z.object({                                  // NEW — repos-view-only settings
    autoRefreshSec: z.number().int().min(0).max(1800).default(0),
  }).default({}),
})
```

`redactConfig()` exposes `ignoredRepos` and `repos.autoRefreshSec` as-is (no secrets in either).

User's one-time manual migration during cutover (step 11):
1. Open Settings in the running PWA.
2. Cat `~/code/git-status-dashboard/config.json` — copy `projectDirs[]` and `ignoredRepos[]`.
3. Union `projectDirs` into existing `scanPaths` (dedupe by absolute-path resolve).
4. Paste `ignoredRepos[]` into the new field.

---

## AI integration

Two paths, gated by content type, no code unification:

| Use case | Path | Module | Failure mode |
|---|---|---|---|
| Feedback triage (text + image → JSON) | GitHub Copilot API | `lib/triage.ts` (existing) | 400 `NO_COPILOT_TOKEN` if no Copilot account configured |
| AI commit message (diff → text) | `~/.claude/PAI/Tools/Inference.ts` | `lib/inference.ts` (new) | 503 if Inference.ts missing |
| AI repo triage (repo list → text) | `~/.claude/PAI/Tools/Inference.ts` | `lib/inference.ts` (new) | 503 if Inference.ts missing |

`lib/inference.ts` shells out via `Bun.spawn(["bun", INFERENCE_PATH, "--level", "fast", systemPrompt, userPrompt])` and returns stdout. It checks the file's existence once at process start (cached) and again per-call (cheap `stat`) so users can install PAI later without a server restart.

---

## PWA / service worker

- `sw.js`: `CACHE_VERSION` `'v3'` → `'v4'`. Cleanup logic already deletes old `feedback-tool-*` caches; new caches stay named `feedback-tool-v4` (don't rename the cache prefix — it's the cleanup match key).
- Manifest `start_url` stays `/`. Adding `shortcuts` is backward-compatible — browsers without shortcut support ignore the field.
- New git endpoints under `/api/git/*` match the existing `url.pathname.startsWith('/api/')` rule and are correctly network-only.
- Offline: when `navigator.onLine === false`, the Repos view shows a banner and skips fetches. No stale data display.

---

## Test plan (run with `bun test`)

New tests in `tests/`:
1. `gitStatus.test.ts` — `parseAheadBehind('1\t2')` → `{ ahead: 1, behind: 2 }`; empty/malformed inputs return zeros.
2. `gitStatus.test.ts` — `parseBranchRefs` handles `[gone]` upstream, "ahead 3, behind 1", blank/garbage lines.
3. `gitStatus.test.ts` — `validateRepoPath` rejects `..`, rejects paths outside `scanPaths`, accepts paths inside, resolves symlinks before comparing.
4. `gitStatus.test.ts` — `getGitRepos` excludes paths in `ignoredRepos` (after resolution).
5. `gitStatus.test.ts` — `pMap(items, fn, 2)` over 5 items completes all 5 and preserves input order in the result.
6. `gitOps.test.ts` — `/api/git/delete` refuses a path that exists but has no `.git/` directory inside it.
7. `gitOps.test.ts` — `/api/git/delete` refuses a path that's a parent of, or outside, every `scanPaths` entry.
8. `gitOps.test.ts` — `pullAllSafe` filters to only `behind > 0 && uncommitted === 0 && !error` repos.

Existing tests (`triage.test.ts`, `github.test.ts`, `gitlab.test.ts`, `scanner.test.ts`, `config.test.ts`) must still pass — none of their files change behavior.

Manual smoke after cutover (step 13):
- Switch to Repos view → grid renders.
- Click a clean repo's pull button → no-op without error.
- Click a dirty repo's "AI commit msg" → modal shows generated text (or 503 with a clear message if Inference.ts missing).
- Click `Ignore` → repo disappears; check Ignored drawer → it's there; `Unignore` → it returns.
- Click `Delete` → confirm modal asks to type the repo name → only the typed-correct path goes through.
- Switch back to Feedback view → existing flow still works end-to-end (type → triage → submit).

---

## Cutover steps (in order)

1. **Stop the standalone dashboard service.** Run `~/code/git-status-dashboard/uninstall.sh`. This unloads `com.git-status-dashboard` and removes the plist.
2. **Verify port 3847 is free**: `lsof -ti :3847` returns empty.
3. **Back up feedback-tool config**: `cp ~/.config/feedback-tool/config.json ~/.config/feedback-tool/config.json.bak`.
4. **Add new files** in `~/code/feedback-tool/`: `lib/gitStatus.ts`, `lib/gitOps.ts`, `lib/inference.ts`, `tests/gitStatus.test.ts`, `tests/gitOps.test.ts`.
5. **Extend `lib/config.ts`** with `ignoredRepos` + `repos.autoRefreshSec`; update `redactConfig`. Update `ConfigUpdateSchema` in `index.ts` to match.
6. **Add the 12 new routes** in `index.ts`. All mutating routes guarded.
7. **Run `bun test`** — all new + existing tests pass.
8. **Update `public/app.html`** with tab bar, `view-feedback` wrapper, `view-repos` section, and the new `<script>` block.
9. **Bump `public/sw.js` `CACHE_VERSION`** to `'v4'`.
10. **Update `public/manifest.json`** — name/short_name "Glass", description, shortcuts.
11. **Manual migration**: in the running PWA's Settings, union `projectDirs` from `~/code/git-status-dashboard/config.json` into `scanPaths`; paste `ignoredRepos`.
12. **Restart the feedback-tool server**, then hard-reload the PWA window. Service worker cache bump triggers `skipWaiting` + `clients.claim` so the new shell is live without an uninstall/reinstall.
13. **Smoke test** per the list above.
14. **Archive**: `mv ~/code/git-status-dashboard ~/code/_archived/git-status-dashboard`. (Create `_archived/` if missing.)

---

## Verification (how to know it worked)

- `bun test` in `~/code/feedback-tool/` — all green, including the 8 new test cases.
- `lsof -ti :7777` shows the feedback-tool server running; `lsof -ti :3847` shows nothing.
- `launchctl list | grep git-status-dashboard` returns empty.
- Open the installed PWA from the dock. Title bar reads **Glass**. Tab bar shows `Feedback` and `Repos`.
- `Feedback` tab: existing flow works end-to-end (no regression).
- `Repos` tab: grid loads, filters work, pull/push/ignore/unignore/AI-commit-msg/AI-triage/delete all behave.
- Right-click the dock icon → shortcuts list shows both views (browser/OS dependent; not a hard requirement).
- `~/.config/feedback-tool/config.json` contains `ignoredRepos` and the unified `scanPaths`.
- `~/code/git-status-dashboard/` no longer exists at that path; lives under `~/code/_archived/` instead.

---

## Open issues / future work (not part of this plan)

- Settings UI surface for `ignoredRepos` and `repos.autoRefreshSec` is currently in-view only (chips on cards + a toolbar select). A Settings-panel editor for the ignored list could be added later if the in-view affordance proves insufficient.
- The deep-scan vs flat-scan divergence between views is intentional and documented at the call sites. If it ever becomes confusing, consolidate by giving the feedback view a depth-1 mode too.
- `app.html` is approaching ~2000 lines after this merge. A future refactor could split the two view scripts into separate `<script src="/js/feedback.js">` / `<script src="/js/repos.js">` files served by Hono — but that's churn beyond this plan's scope.
