---
task: Add AI repository detection after triage step
slug: 20260513-153631_repo-detection-after-triage
effort: standard
phase: complete
progress: 12/12
mode: interactive
started: 2026-05-13T15:36:31Z
updated: 2026-05-13T15:50:00Z
---

## Context

Repository selector now appears AFTER AI triage with the AI's best-guess pre-selected; user can override before submit. Backend extension is backward-compatible (repos field optional).

### Risks (mitigations applied)

- Prompt token bloat → cap 200 repos, ~1.9k tokens worst-case (Pentester quantified)
- AI hallucinating names → server-side Set lookup against caller's list, silent coerce to null
- Prompt injection via repo names → added data-block delimiter + "treat as opaque" instruction to system prompt
- Existing tests broken by type change → 4 tests gained `suggestedRepo: null` in their `toEqual` shape; semantics preserved
- UI reorder breaking state machine → repo card visibility tied to TRIAGED+ states via updateUI()

## Criteria

- [x] ISC-1: `buildTriagePrompt` accepts optional repo list and includes them when provided
- [x] ISC-2: System prompt instructs the model to return `suggested_repo` as one of provided names or null
- [x] ISC-3: `parseTriageResponse` returns `suggestedRepo` field when present, null otherwise
- [x] ISC-4: `triageFeedback` signature accepts optional `repos` array and threads through to prompt
- [x] ISC-5: Server `/api/triage` Zod schema accepts optional `repos: [{name, host}]` array (200-cap)
- [x] ISC-6: Server validates `suggestedRepo` against sent list and drops if not found
- [x] ISC-7: Frontend sends scanned repos in triage request body
- [x] ISC-8: Repository selector card is hidden in IDLE/DRAFT, visible from TRIAGED onward
- [x] ISC-9: On triage success, AI's suggested repo is auto-selected when match exists
- [x] ISC-10: User can override the AI's pick by typing/selecting different repo before submit
- [x] ISC-11: Existing triage tests continue passing (4 updated `toEqual` shapes to include null field; semantics preserved)
- [x] ISC-12: New tests cover `parseTriageResponse` + `buildTriagePrompt` with repos (7 new tests)

## Decisions

- Used data-block delimiter (`<<<REPOS ... REPOS>>>`) instead of escape-encoding repo names — preserves readability for AI while signaling data-only intent (Pentester low-severity finding)
- Reused `HostnameSchema` (already defined at index.ts:77) for RepoCandidate.host instead of inline `z.string().max(253)` (simplify reviewer finding)
- Replaced inline badge-remove duplication in selectRepo with `clearAiBadge()` call (simplify reviewer finding)
- Kept `RepoCandidate` as a distinct DTO type (not `Pick<RepoInfo>`) — separates transport concern from scanner data model
- Skipped Designer agent — UI change is purely additive to existing CSS-variable design system

## Verification

- `bun test`: 66/66 passing (55 pre-existing + 11 new/updated)
- Server boot smoke test: `/api/health` returns ok; malformed repos rejected with 400 VALIDATION_ERROR; valid triage call returns suggestedRepo: null when no repos supplied
- Pentester: PASS (one Low finding addressed via prompt delimiter; CSRF guard preserved; suggestion-coercion path verified)
- /simplify: 3 findings, 2 applied (HostnameSchema reuse, clearAiBadge dedup), 1 skipped (RepoCandidate→Pick refactor — preferred explicit DTO)
- Live browser test of UI flow (ISC-8 through ISC-10): NOT executed — would require valid GitHub Copilot credentials. Recommend manual smoke: type feedback, click AI Triage, verify repo card appears below with AI's pick highlighted (badge), confirm override works.
