# Architect Plan — Git Glass Inbox + Mergeable

Intent: feature

## Scope Estimate
- Files Created: 6 — `lib/notifications.ts`, `lib/work.ts`, `lib/mergeable.ts`, `tests/notifications.test.ts`, `tests/work.test.ts`, `tests/mergeable.test.ts`
- Files Modified: 6 — `index.ts`, `public/app.html`, `public/sw.js`, `lib/issues.ts` (shared remotes/helpers only), `CLAUDE.md`, this work folder

## Modes
Notifications (default) · Work · Mergeable · All local · This repo

## DTOs

### NotificationRow
```ts
{
  id: string;
  host: string; hostType: "github"|"gitlab";
  account: string | null;
  reason: "review"|"assign"|"mention"|"author"|"ci"|"bot"|"watching"|"subscribed"|"other";
  unread: boolean; done: boolean;
  title: string; repo: string | null;
  subjectType: string;
  htmlUrl: string; updatedAt: string;
  threadId: string;
  muteSupported: boolean;
  isLocalRemote: boolean;
}
```

### WorkRow
IssueRow + `{ kind: "issue"|"pr"; attention: "review"|"assign"|"author"|"mention"|"other"; }`

### MergeableRow
```ts
{
  id, host, hostType, owner, repo, number, title, htmlUrl,
  account: string | null, author: string,
  ready: boolean, reasons: string[],
  mergeableState: string,
  checksClean: boolean, approved: boolean, notBehind: boolean,
  allowedMethods: ("merge"|"squash"|"rebase")[],
  defaultMethod: "merge"|"squash"|"rebase",
  deleteBranchDefault: boolean,
  commitTitleDefault: string, commitMessageDefault: string,
}
```

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/notifications` | localOnly=1 default, includeCi, includeBots, includeWatching, account, force |
| POST | `/api/notifications/done` | threadId, hostType, host, account? |
| POST | `/api/notifications/read` | threadId, hostType, host, account?, unread? |
| POST | `/api/notifications/mute` | GH only |
| GET | `/api/work` | local remotes; issues+PRs |
| GET | `/api/mergeable` | ship queue list |
| GET | `/api/mergeable/status` | live uncached re-fetch |
| POST | `/api/mergeable/merge` | re-validate ready; no admin; no bulk |

All POSTs: sameOriginGuard. Tokens server-side only.

## Pure helpers (TDD)
- notifications: mapGhReason, isCiOrBot, isParticipatingReason, filterNotificationDefaults, groupByReason, countUndone, dedupeNotificationRows
- work: buildGitHubWorkQueries, sortWorkSections, mapAttention
- mergeable: isReady, mapGhMergeability, mapGlMergeability, pickDefaultMethod, reasonsNotReady

## Host mapping
- GH notifications multi-account; soft triage PATCH/DELETE/PUT subscription
- GL todos; mute unsupported
- Work: issue+pr search with review-requested
- Mergeable: ready = checks + approved + not behind; merge PUT

## ISC
1. Tab Inbox; modes order; default Notifications
2. GET notifications multi-account + GL; soft-fail; cache
3. Default local + participating; CI/bots/watching opt-in
4. not-done inbox; dim read; group by reason
5. Soft triage CSRF; mute GL off; per-account token
6. Bulk + keyboard j/k e o m u Notifications only
7. Soft poll 2–5m focused; badge undoned
8. Work issues+PRs local Reviews→Assigned→rest
9. Mergeable ready predicate + universe
10. Merge confirm + live status; no bulk/bypass
11. Method memory + title/body + delete per repo setting
12. GH+GL parity (mute exception)
13. Unit tests green; CACHE_VERSION bump

## Security
sameOriginGuard on all POSTs; no tokens in responses; Zod bodies; server re-validate merge; no path-based merge API

## Phased build
1. TDD pure helpers
2. notifications lib + routes
3. work lib + routes
4. mergeable lib + routes
5. SPA chrome + Notifications
6. Work + Mergeable UI + modal
7. sw bump, docs, smoke
