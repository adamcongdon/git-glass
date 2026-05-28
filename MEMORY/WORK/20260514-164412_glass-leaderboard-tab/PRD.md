---
task: Add Leaderboard tab ranking projects by activity
slug: 20260514-164412_glass-leaderboard-tab
effort: extended
phase: build
progress: 35/35
mode: interactive
started: 2026-05-14T20:44:12Z
updated: 2026-05-14T20:45:00Z
---

## Context

Glass (the unified feedback-tool + git-status-dashboard app at `/Users/adam.congdon/code/feedback-tool`) currently exposes two top-level tabs: **Feedback** and **Repos**. Adam wants a third tab — **Leaderboard** — that ranks the scanned local repositories from most-active to least-active using git-history-derived signals (commits, lines changed, recency, etc.).

Scope:
- Backend: a new `GET /api/leaderboard` endpoint in `index.ts` backed by a new `lib/leaderboard.ts` module that runs `git log` per repo and aggregates per-window statistics. Reuses existing `scanPaths`/`ignoredRepos` config and the existing `runGit` + `pMap` helpers from `lib/gitStatus.ts`.
- Frontend: a new `#glass-tab-leaderboard` tab, a new `#view-leaderboard` panel, and the JS needed to fetch + render the ranking, all inside `public/app.html` (single-file SPA, no bundler).
- Activity score: composite of commits (weighted), files changed, lines added/deleted, and exponential recency decay against `lastCommitDate`. Deterministic and documented in `lib/leaderboard.ts`.
- Window selector: 7d / 30d / 90d / all, default 30d.
- Veeam branding: reuse existing `glass-*` CSS vars (Veeam Green `#00D15F`); no hardcoded colors.
- PWA: bump `CACHE_VERSION` in `public/sw.js` so soft refresh delivers the new shell (durable memory).

Reasoning for inclusion of "Leaderboard" as a primary nav tab rather than a sub-view of Repos: Adam asked explicitly for a new page peer to Feedback and Repos, and the existing tab pattern (roving tabindex, Cmd+1/2 shortcuts) extends cleanly to Cmd+3.

### Risks
- `git log --since` is per-repo and serial-per-repo; with many repos this can slow the endpoint. Mitigation: reuse `pMap` (concurrency 8) and add a short in-memory cache (~30s) keyed by `(window, repo path, last commit sha)`.
- Repos with no commits in window must score 0 without throwing — must catch per-repo errors and tag the result, never fail the whole endpoint.
- Service worker may serve stale `app.html` and hide the new tab — must bump `CACHE_VERSION` (Adam was burned by this before per stored memory).
- Activity score is opinionated; needs to be documented + unit-tested so future tweaks are intentional, not accidental.
- Existing accessibility (roving tabindex, aria-controls, Cmd+1/2) must extend to include Leaderboard without regressing Feedback/Repos navigation.

### Plan

**Files to add:**
- `lib/leaderboard.ts` — `parseWindow()`, `getRepoActivity(repoPath, sinceISO)`, `scoreActivity(stats, windowDays)`, `getLeaderboard(config, window)`.
- `tests/leaderboard.test.ts` — unit tests for `parseWindow` and `scoreActivity`; smoke test for `getLeaderboard` against a tmp git repo.

**Files to modify:**
- `index.ts` — register `GET /api/leaderboard`, with `window` query param validated by zod, error mapped via `errorResponse`. No CSRF guard needed (GET).
- `public/app.html` — add `<button id="glass-tab-leaderboard">` to `#glass-tabbar`, add `<section id="view-leaderboard">` with toolbar (window selector) + list, extend `setActiveView()` / Cmd+3 / arrow-key roving, add `glassLoadLeaderboard()` JS, add `glass-leaderboard-*` CSS using existing brand vars.
- `public/sw.js` — bump `CACHE_VERSION` from `v4` to `v5`.

**Activity score formula (to encode in `scoreActivity()`):**
```
score = (commits * 10)
      + (filesChanged * 1)
      + ((additions + deletions) * 0.05)
      + recencyBonus
recencyBonus = 50 * exp( -daysSinceLastCommit / halfLife )
  where halfLife = max(windowDays / 4, 3)
```
Rationale: commits dominate (humans grouping work into commits is the strongest activity signal), file breadth and line volume add nuance, recency bonus rewards "still active" over "burst-and-stopped" within the window. Window=all uses halfLife=30.

**API contract:**
```
GET /api/leaderboard?window=30d
→ 200 { window: "30d", windowDays: 30, generatedAt: ISO, totalRepos: N,
        repos: [
          { name, path, commits, filesChanged, additions, deletions,
            lastCommitDate, score, error?: string }
        ] }
→ 400 { error: { code: "VALIDATION_ERROR", message, status: 400 } }
```
`repos` is pre-sorted by score desc, then lastCommitDate desc.

## Criteria

UI tab + view shell:
- [x] ISC-1: Button `#glass-tab-leaderboard` exists inside `#glass-tabbar`
- [x] ISC-2: Tab order in DOM is Feedback, Repos, Leaderboard (left-to-right)
- [x] ISC-3: Leaderboard tab uses the existing `.glass-tab` class
- [x] ISC-4: Leaderboard tab has `role="tab"` and `aria-controls="view-leaderboard"`
- [x] ISC-5: New section `#view-leaderboard` exists in DOM after `#view-repos`
- [x] ISC-6: `#view-leaderboard` is `hidden` unless `glassState.activeView === 'leaderboard'`

Navigation behavior:
- [x] ISC-7: Cmd+3 / Ctrl+3 activates the Leaderboard view
- [x] ISC-8: ArrowLeft/ArrowRight roving cycles through all three tabs
- [x] ISC-9: `localStorage 'glass.activeView' = 'leaderboard'` persists across reload
- [x] ISC-10: Switching to Leaderboard lazy-loads data on first activation only

Backend API:
- [x] ISC-11: `GET /api/leaderboard` registered and returns 200 on valid request
- [x] ISC-12: `window` query param accepts `7d`, `30d`, `90d`, `all` (default `30d`)
- [x] ISC-13: Invalid window returns 400 with code `VALIDATION_ERROR`
- [x] ISC-14: Each repo result includes name, path, commits, additions, deletions, filesChanged, lastCommitDate, score
- [x] ISC-15: Top-level response includes window, windowDays, generatedAt, totalRepos
- [x] ISC-16: Endpoint excludes paths listed in config `ignoredRepos`
- [x] ISC-17: Per-repo git failure sets `error` field on that repo only; endpoint still returns 200

Scoring:
- [x] ISC-18: `scoreActivity()` implements documented formula deterministically
- [x] ISC-19: A repo with zero commits in window has `score === 0`
- [x] ISC-20: Ties broken by `lastCommitDate` descending
- [x] ISC-20b: `scoreActivity()` accepts injectable `now: Date` for deterministic tests

UI rendering:
- [x] ISC-21: Leaderboard renders list sorted by score descending, rank 1 at top
- [x] ISC-22: Each row shows rank, repo name, score, commits, lines (`+adds / −dels`), relative `lastCommitDate`
- [x] ISC-23: Window selector (`7d` / `30d` / `90d` / `all`) switches window and triggers refetch
- [x] ISC-24: Empty state message shown when zero repos have commits in window
- [x] ISC-25: Loading state shown during fetch; error variant of `#glass-banner` shown on failure

Branding & isolation:
- [x] ISC-26: New CSS uses existing `glass-*` vars (Veeam Green `#00D15F`), no new hardcoded hex
- [x] ISC-27: All new CSS classes carry the `glass-` prefix

Tests:
- [x] ISC-28: Unit test for `parseWindow()` covers `7d`, `30d`, `90d`, `all`, invalid
- [x] ISC-29: Unit test for `scoreActivity()` asserts zero-commits → 0 and ordering of two fixtures
- [x] ISC-30: Integration test hits `GET /api/leaderboard?window=30d` and asserts shape

PWA cache:
- [x] ISC-31: `CACHE_VERSION` in `public/sw.js` bumped (e.g. `v4` → `v5`)

Anti-criteria (must NOT happen):
- [x] ISC-A1: Existing `.card` / `.btn-green` / legacy classes NOT modified
- [x] ISC-A2: NO GitHub API calls added (local git only)
- [x] ISC-A3: Cmd+1 / Cmd+2 still activate Feedback / Repos respectively (no regression)

## Decisions

- **Mid-pipeline addition (2026-05-14T21:05Z): Claude cost per repo.** User requested showing month-to-date Claude API spend per repo, sourced from PAI's existing `~/.claude/MEMORY/STATE/usage-cache.json` (`project_costs.month_used_cents[slug]`). Slug derivation matches statusline-command.sh: absolute path with `/` and `.` replaced by `-`. Added `slugifyPath`, `getClaudeCostMap` to `lib/leaderboard.ts`, extended `RepoLeaderboardEntry` with `claudeCostCents: number`, rendered as USD in a new column. NOT incorporated into score (display only — user asked to add, not re-rank). CACHE_VERSION bumped v5 → v6 for the UI change. 5 additional tests added (slugifyPath + getClaudeCostMap fixtures). 139/139 tests passing.
- **Simplify pass (post-Engineer):** extracted score-formula constants (`COMMIT_WEIGHT`, `FILE_WEIGHT`, `LINE_WEIGHT`, `RECENCY_MAX`, `HALF_LIFE_ALL`, `HALF_LIFE_FLOOR`), capped `activityCache` at 500 entries, removed duplicate row-clear in `glassRenderLeaderboard`, added same-window no-op guard on window selector clicks, dropped narrating comments and ISC ticket from test describe block.
- **Repo-level metric, not author-level.** Adam asked to rank "my projects" — these are local repos he owns, and per-author breakdown would add UI noise without insight. If a multi-author view is wanted later, add `authorFilter` to the query.
- **Activity score formula** as documented in `## Context → Plan`. Commits dominate (10pt each), files (1pt), lines (0.05pt), recency bonus up to 50pt with halfLife = `max(windowDays/4, 3)`. `windowDays='all'` uses halfLife=30.
- **Score determinism via injectable `now`.** `scoreActivity(stats, windowDays, now = new Date())` — tests pass a fixed Date.
- **In-memory cache, key = `${window}::${repoPath}::${lastSha}`.** Trivially correct invalidation (sha changes → bust). No TTL needed.
- **GET endpoint, no CSRF guard.** Read-only, idempotent. Matches existing `/api/git/repos` pattern.
- **No new deps.** Reuse `pMap`, `runGit`, `getGitRepos` from `lib/gitStatus.ts`; reuse `readConfig` from `lib/config.ts`.
- **PWA cache bump v4 → v5.** Locked-in rule from durable memory — UI edits to `public/app.html` require it.

## Verification
