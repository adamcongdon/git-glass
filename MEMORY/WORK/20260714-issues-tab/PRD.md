---
task: Add Issues tab for local-clone issue inventory
slug: 20260714-issues-tab
effort: advanced
phase: complete
started: 2026-07-14T14:04:00Z
updated: 2026-07-14T14:20:00Z
---

## Goal

Fourth primary tab **Issues** listing open (etc.) issues across local clones on GitHub + GitLab, with Mine / All local / This repo modes, filters, host links, no in-app mutations.

## Decisions (from Grill-Me)

- Hybrid modes; default Mine (assigned + authored + mentioned)
- Issues only (PRs later); GitHub + GitLab; local clones only
- Read-only + open on host; identity derived from existing config
- Filters: repo, labels, author/assignee, host, updated presets
- Sort by updated; 50/page load more; 90s cache; soft-fail banner
- Tab order: Feedback · Repos · Issues · Leaderboard (Cmd+3 Issues, Cmd+4 Leaderboard)
- Deferred: remote-only clone, PR reviews, in-app triage actions

## Files

- `lib/issues.ts` (new)
- `tests/issues.test.ts` (new)
- `index.ts` — `GET /api/issues`
- `public/app.html` — tab + view + JS
- `public/sw.js` — CACHE_VERSION v22
- `CLAUDE.md` — architecture note

## Verification

- `bun test` — 259 pass including 20 issues unit tests
- Live `getIssues({mode:mine})` → 46 matched against local remotes
- HTTP smoke: GET `/api/issues` returns issues; HTML contains `#glass-tab-issues`
