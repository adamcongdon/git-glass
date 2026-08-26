# Git Glass feature map

Agent navigation for the running app. Loopback. Do not weaken CSRF or validateRepoPath.

**Boot:** `bun run start` then open http://127.0.0.1:7777
**Verify:** `bash scripts/verify.sh` (tests + live health)
**Tests:** `bun test`
**Config:** `~/.config/feedback-tool/config.json` (mode 0600). Package name stays `feedback-tool`.

| User thing | UI | API | Notes |
|---|---|---|---|
| Health | -- | GET /api/health -> `{ ok: true }` | Live-proof minimum |
| Version | Settings, Update | GET /api/version | |
| Feedback / triage | Feedback view | POST /api/triage | CSRF |
| Open issue | Feedback view | POST /api/issues | CSRF; GitHub or GitLab |
| Repos list | Repos | GET /api/git/repos | |
| Pull / send-upstream | Repos row | POST /api/git/pull and the matching send-upstream route | CSRF + validateRepoPath |
| Delete repo | Repos row | POST /api/git/delete | Triple-validated. Irreversible -- ask Adam |
| Inbox | Inbox | GET /api/notifications | |
| Work | Inbox, Work | GET /api/work | |
| Mergeable | Inbox, Mergeable | GET /api/mergeable ; POST /api/mergeable/merge | Merge is irreversible -- ask |
| Leaderboard | Leaderboard | GET /api/leaderboard?window=30d | |
| Config | Settings | GET/PUT /api/config | GET redacts keys |

**Hard constraints (tests, not markdown):**
- Mutating routes use sameOriginGuard
- validateRepoPath before every mutation
- deleteRepo triple-check (scanPath, directory, .git directory)

**Land:** open a PR targeting `main` with `Closes #N`. No direct feature commits on `main`.
