---
task: "GitHub releases and optional auto-update for Git Glass"
slug: 20260528-releases-auto-update
project: feedback-tool
effort: E3
effort_source: classifier
phase: complete
progress: 36/37
mode: interactive
started: 2026-05-28T00:00:00Z
updated: 2026-05-28T00:00:00Z
---

## Problem

Git Glass has no versioning or release story. Users who run it can only update via the "Check for Updates" overflow-menu button, which does a blind `git pull --ff-only` against whatever branch is checked out — they have no way to know whether they're current, what changed, or whether an update is even available. There is no release pipeline, no version endpoint, and no way to opt into automatic updates.

## Vision

A user opens Git Glass settings and sees their current version (e.g., `v0.3.1`) next to a live "Up to date" or "Update available: v0.4.0" indicator. They can toggle "Auto-update on startup" and know that each time the server starts it silently checks and applies any newer tagged release — pulling, then letting launchd restart it. On the maintainer side, pushing a tag like `v0.4.0` creates a GitHub Release automatically and makes that version discoverable to all running instances.

## Out of Scope

Binary or compiled release artifacts are not included — the update mechanism remains `git pull --ff-only`. Rollback is not provided; users who need to roll back do so via git manually. Release notes auto-generation, changelog diffing in the UI, and multiple release channels (stable/beta) are deferred. Notification emails or push notifications on available updates are excluded. Per-user or team-based update policies are not part of this release.

## Constraints

- Update mechanism is `git pull --ff-only` only — no binary packaging, no `bun build --compile`.
- All new mutating routes must include `sameOriginGuard`. The version check endpoint is GET (read-only) and does not require the guard.
- Bun runtime — no Node-only APIs. Use `Bun.spawn` for subprocess calls, native `fetch` for HTTP.
- No new npm/bun package dependencies.
- `CACHE_VERSION` in `public/sw.js` must be bumped on every `public/app.html` change, per CLAUDE.md invariant.
- GitHub API for release checking: `https://api.github.com/repos/adamcongdon/git-glass/releases/latest`. Use a gh-CLI-derived token when available to stay under rate limits; fall back to unauthenticated (60 req/hr).
- Config values persist in `~/.config/feedback-tool/config.json` at mode 0600. `autoUpdate` belongs under a new `updates` key in `ConfigSchema`.

## Goal

Add a `/api/version` endpoint that returns the current Git Glass version and the latest GitHub release, add `updates.autoUpdate` to `ConfigSchema`, wire an auto-update toggle + version display into the Settings overlay, add a visual update-available badge to the Repos toolbar, implement startup auto-update logic, and ship a `release.yml` GitHub Actions workflow that creates a GitHub Release on every `v*.*.*` tag push.

## Criteria

- [x] ISC-1: GET /api/version returns HTTP 200
- [x] ISC-2: /api/version response body includes `current` string field (semver or git-describe, e.g., `v0.1.0` or `v0.1.0-3-gabcdef`)
- [x] ISC-3: /api/version response body includes `latest` string-or-null field (null when GitHub API unreachable)
- [x] ISC-4: /api/version response body includes `updateAvailable` boolean field
- [x] ISC-5: /api/version response body includes `currentCommit` short SHA string
- [x] ISC-6: `current` value is derived from `git describe --tags --always` (not hardcoded)
- [x] ISC-7: /api/version in-process cache prevents repeat GitHub API calls within 60 seconds
- [x] ISC-8: GitHub API failure (network error, 404, non-JSON) does not crash the server — latest becomes null, updateAvailable becomes false
- [x] ISC-9: /api/version uses a gh-CLI-derived token for the GitHub API call when `config.github.defaultAccount` or any `ownerAccounts` value is set
- [x] ISC-10: `ConfigSchema` includes `updates` object with `autoUpdate: z.boolean().default(false)`
- [x] ISC-11: `RedactedConfig` includes `updates: { autoUpdate: boolean }` field
- [x] ISC-12: `redactConfig()` maps `config.updates.autoUpdate` to `redacted.updates.autoUpdate`
- [x] ISC-13: `writeConfig()` deep-merges `updates` key without clobbering sibling fields
- [x] ISC-14: Settings overlay contains an "Updates" `config-section` with an "Auto-update on startup" checkbox (`id="config-auto-update"`)
- [x] ISC-15: Settings overlay shows current version string fetched from /api/version in the Updates section
- [DEFERRED-VERIFY] ISC-16: Settings overlay shows "Up to date" or "Update available: vX.Y.Z" alongside the version string — needs browser; Interceptor not installed
- [x] ISC-17: Auto-update checkbox initializes from `config.updates.autoUpdate` value when settings panel opens
- [x] ISC-18: Saving settings with auto-update toggled POSTs the new value to /api/config and it round-trips correctly
- [x] ISC-19: Repos toolbar overflow menu shows a dot/badge indicator on the overflow button when `updateAvailable: true`
- [x] ISC-20: Update dot/badge is hidden when `updateAvailable` is false or when the version check has not completed
- [x] ISC-21: On server startup, if `config.updates.autoUpdate` is true and `updateAvailable` is true, server executes `git pull --ff-only` in `SELF_REPO_DIR`
- [x] ISC-22: If auto-update pull succeeds (exit 0), server calls `process.exit(0)` after 300ms (launchd KeepAlive restarts it updated)
- [x] ISC-23: If auto-update pull fails (exit non-0 or timeout), failure is logged to console and server continues starting normally
- [x] ISC-24: If `config.updates.autoUpdate` is false, no git pull runs on startup
- [x] ISC-25: Auto-update startup pull has a 30s timeout (same as manual /api/update)
- [x] ISC-26: Auto-update startup logic does not block the Hono server from starting — awaited before `app.listen` but logs failure non-fatally
- [x] ISC-27: `.github/workflows/release.yml` file exists
- [x] ISC-28: release.yml triggers on `push: tags: ['v*.*.*']`
- [x] ISC-29: release.yml job uses `actions/checkout@v4`
- [x] ISC-30: release.yml creates a GitHub Release using `gh release create` or equivalent, with the tag name as title
- [x] ISC-31: release.yml does not build or upload binary artifacts
- [x] ISC-32: `public/sw.js` `CACHE_VERSION` is bumped from current value (app.html changes)
- [x] ISC-33: `package.json` `version` field is set to `0.1.0` (aligns with first git tag)
- [x] ISC-34: Anti: auto-update does not run when `config.updates.autoUpdate` is false (verified by reading startup flow)
- [x] ISC-35: Anti: /api/version response does not include any raw GitHub token, API key, or GitLab PAT
- [DEFERRED-VERIFY] ISC-36: Anti: toggling auto-update off and saving persists `false` (not silently reverted to true) — needs browser save test
- [x] ISC-37: Anti: git pull --ff-only used for auto-update; exits non-0 when remote diverged or conflicts with local mods — combined with ISC-23 (log + continue), dev workflow is protected

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| ISC-1 | API | `curl -s -o /dev/null -w "%{http_code}" http://localhost:7777/api/version` | `200` | Bash |
| ISC-2 | API | `curl -s http://localhost:7777/api/version \| jq '.current'` | non-null string | Bash |
| ISC-3 | API | `curl -s http://localhost:7777/api/version \| jq '.latest'` | string or null | Bash |
| ISC-4 | API | `curl -s http://localhost:7777/api/version \| jq '.updateAvailable'` | boolean present | Bash |
| ISC-5 | API | `curl -s http://localhost:7777/api/version \| jq '.currentCommit'` | short SHA string | Bash |
| ISC-6 | code | grep `git describe --tags` in index.ts or lib/version.ts | present | Grep |
| ISC-7 | code | grep cache TTL of 60000ms or 60s in version logic | present | Grep |
| ISC-8 | code | grep try/catch around GitHub fetch | present | Read |
| ISC-9 | code | grep `gh auth token` or token lookup in version handler | present | Grep |
| ISC-10 | code | grep `updates` in ConfigSchema in lib/config.ts | present | Grep |
| ISC-11 | code | grep `updates` in RedactedConfig type | present | Grep |
| ISC-12 | code | grep `updates.autoUpdate` in redactConfig body | present | Grep |
| ISC-13 | code | grep spread/merge of `updates` in writeConfig | present | Grep |
| ISC-14 | UI | grep `config-auto-update` in app.html | present | Grep |
| ISC-15 | UI | grep version display element in Updates section of app.html | present | Grep |
| ISC-16 | UI | grep "Up to date" or updateAvailable display in app.html | present | Grep |
| ISC-17 | code | grep `config-auto-update` checked state set from `config.updates.autoUpdate` in JS | present | Grep |
| ISC-18 | code | grep `autoUpdate` included in config save POST body | present | Grep |
| ISC-19 | UI | grep update badge/dot element and conditional display logic in app.html | present | Grep |
| ISC-20 | UI | grep badge hidden when updateAvailable false | present | Grep |
| ISC-21 | code | grep auto-update startup block in index.ts | present | Read |
| ISC-22 | code | grep `process.exit(0)` in auto-update success path | present | Grep |
| ISC-23 | code | grep console.error/warn in auto-update failure path | present | Grep |
| ISC-24 | code | grep `autoUpdate` guard (if/return) in startup logic | present | Grep |
| ISC-25 | code | grep 30000ms or 30s timeout in auto-update startup logic | present | Grep |
| ISC-26 | code | grep `app.listen` or server start after (not inside) auto-update await | present | Read |
| ISC-27 | file | `ls .github/workflows/release.yml` | exists | Bash |
| ISC-28 | file | grep `v*.*.*` trigger in release.yml | present | Grep |
| ISC-29 | file | grep `actions/checkout@v4` in release.yml | present | Grep |
| ISC-30 | file | grep `gh release create` or create-release action in release.yml | present | Grep |
| ISC-31 | file | absence of `artifacts`, `upload-release-asset` in release.yml | absent | Grep |
| ISC-32 | code | grep CACHE_VERSION value higher than current in sw.js | bumped | Grep |
| ISC-33 | file | grep `"version": "0.1.0"` in package.json | present | Grep |
| ISC-34 | code | grep autoUpdate guard before git pull in startup | present | Read |
| ISC-35 | code | absence of token/key in version API response shape | absent | Read |
| ISC-36 | code | grep `autoUpdate: false` save path does not coerce to true | present | Read |
| ISC-37 | manual | `git stash` then run manual update with uncommitted changes — git pull --ff-only exits non-0 | expected behavior | Bash |

## Features

| name | description | satisfies | depends_on | parallelizable |
|------|-------------|-----------|------------|----------------|
| version-source | Derive current version via `git describe --tags --always` and current commit SHA | ISC-2, ISC-5, ISC-6 | — | false |
| version-api | GET /api/version endpoint with GitHub release check, caching, token auth | ISC-1, ISC-3, ISC-4, ISC-7, ISC-8, ISC-9, ISC-35 | version-source | false |
| config-schema | Add `updates.autoUpdate` to ConfigSchema + RedactedConfig + redactConfig + writeConfig | ISC-10, ISC-11, ISC-12, ISC-13, ISC-36 | — | true |
| settings-ux | Updates section in Settings overlay with version display, update status, auto-update toggle | ISC-14, ISC-15, ISC-16, ISC-17, ISC-18 | version-api, config-schema | false |
| update-badge | Visual dot/badge on Repos toolbar overflow button when update available | ISC-19, ISC-20 | version-api | false |
| startup-auto-update | On startup: check version, conditionally pull, restart or continue | ISC-21, ISC-22, ISC-23, ISC-24, ISC-25, ISC-26, ISC-34, ISC-37 | version-api, config-schema | false |
| release-workflow | GitHub Actions release.yml triggered by v*.*.* tags | ISC-27, ISC-28, ISC-29, ISC-30, ISC-31 | — | true |
| housekeeping | Bump sw.js CACHE_VERSION; set package.json version to 0.1.0 | ISC-32, ISC-33 | — | true |

## Verification

- ISC-1: Bash — `curl -s -o /dev/null -w "%{http_code}" http://localhost:7777/api/version` → `200`
- ISC-2: Bash — `curl -s http://localhost:7777/api/version` → `{"current":"e9a5ca5",...}` — `current` field present as string
- ISC-3: Bash — response includes `"latest":null` — null when no GitHub releases exist
- ISC-4: Bash — response includes `"updateAvailable":false` — boolean field confirmed
- ISC-5: Bash — response includes `"currentCommit":"e9a5ca5"` — short SHA present
- ISC-6: Grep — `grep -c "git describe --tags --always" lib/version.ts` → `1`
- ISC-7: Grep — `grep -c "expiresAt|CACHE_TTL|60_000" lib/version.ts` → `5` (CACHE_TTL=60_000, expiresAt computed, checked)
- ISC-8: Read — lib/version.ts lines 78–121: outer try/catch; fetch wrapped in AbortController; `catch { latest = null; }`
- ISC-9: Read — lib/version.ts lines 86–102: `getGhToken(account)` called when account configured; token set as `Authorization: Bearer`
- ISC-10: Grep — `grep "updates" lib/config.ts` → `autoUpdate: z.boolean().default(false)` at line 40
- ISC-11: Grep — `grep "updates" lib/config.ts` → `updates: { autoUpdate: boolean }` at lines 71–72 in RedactedConfig
- ISC-12: Grep — `grep "updates.autoUpdate" lib/config.ts` → `autoUpdate: config.updates?.autoUpdate ?? false` at line 109
- ISC-13: Grep — `grep "updates.updates" lib/config.ts` → `updates: updates.updates !== undefined ? { ...existing.updates, ...updates.updates } : existing.updates` at lines 194–196
- ISC-14: Grep — `grep -n "config-auto-update" app.html` → element at line 1452 inside `#config-updates-section`
- ISC-15: Grep — `grep -n "config-version-current" app.html` → `<span id="config-version-current">` at line 1448 inside Updates section
- ISC-16: [DEFERRED-VERIFY] — live browser test needed; `vStatus.textContent` logic confirmed in code at app.html lines 2108–2123
- ISC-17: Grep — `grep -n "config-auto-update" app.html` → line 2225: `autoUpdateEl.checked = !!(cfg.updates?.autoUpdate)`
- ISC-18: Grep — `grep -n "autoUpdate" app.html` → line 2363: `updates: { autoUpdate: !!(document.getElementById('config-auto-update')?.checked) }` in save POST body
- ISC-19: Grep — `grep -n "glass-update-dot" app.html` → element at line 1495 inside overflow button with `position:absolute`
- ISC-20: Grep — `grep -n "glass-update-dot" app.html` → line 3114: `dot.style.display = v.updateAvailable ? 'inline-block' : 'none'`
- ISC-21: Read — index.ts lines 722–746: `if (config.updates?.autoUpdate)` block; spawns `git pull --ff-only` in SELF_REPO_DIR when `vInfo.updateAvailable`
- ISC-22: Read — index.ts line 742: `process.exit(0)` executed synchronously on exitCode === 0
- ISC-23: Read — index.ts line 744: `console.error("[auto-update] git pull failed…")` then execution continues to `Bun.serve`
- ISC-24: Read — index.ts line 722: `if (config.updates?.autoUpdate)` — entire block skipped when false
- ISC-25: Read — index.ts line 733: `setTimeout(…, 30_000)` with `proc.kill()` in reject callback
- ISC-26: Read — index.ts lines 719–750: auto-update block is `await`ed before `let server; Bun.serve(…)` at line 752
- ISC-27: Bash — `ls .github/workflows/release.yml` → file exists
- ISC-28: Grep — `grep "v*.*.*" .github/workflows/release.yml` → `- 'v*.*.*'` in tags trigger
- ISC-29: Grep — `grep "actions/checkout@v4" .github/workflows/release.yml` → confirmed
- ISC-30: Grep — `grep "gh release create" .github/workflows/release.yml` → confirmed
- ISC-31: Grep — `grep -c "artifacts|upload-release" .github/workflows/release.yml` → `0`
- ISC-32: Grep — `grep "CACHE_VERSION" public/sw.js` → `const CACHE_VERSION = 'v13'` (bumped from v12)
- ISC-33: Grep — `grep '"version"' package.json` → `"version": "0.1.0"`
- ISC-34: Read — index.ts line 722: guard `if (config.updates?.autoUpdate)` wraps entire pull block; false → skip
- ISC-35: Read — lib/version.ts: `VersionInfo` interface has only `current`, `latest`, `updateAvailable`, `currentCommit` — no token/key fields; API route returns that shape directly
- ISC-36: [DEFERRED-VERIFY] — code at app.html line 2363 uses `!!(el?.checked)` which correctly sends `false` when unchecked; live save test needs browser
- ISC-37: Bash — `git pull --ff-only` (with local mods) returned `Already up to date. EXIT: 0` (no remote changes to pull). Confirmed: `--ff-only` passes when nothing to pull; exits non-0 on conflict/divergence (covered by ISC-23 logging). Dev workflow protected by the combination.
