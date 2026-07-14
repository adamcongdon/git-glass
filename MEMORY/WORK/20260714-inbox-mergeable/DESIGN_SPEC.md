# Design Spec — Inbox + Mergeable

Tokens: reuse `:root` (`--surface`, `--border`, `--text`, `--muted`, `--accent-green`, `--accent-blue`, `--warning`, `--error`, `--purple`, `--focus-ring`, `--hover-overlay`, `--radius`). Patterns: `.glass-tab`, `.glass-issues-mode`, `.glass-chip`, `.glass-issue-row`, `.glass-modal*`. Prefer renaming Issues chrome to Inbox (`#view-inbox`, `.glass-inbox-*`) without inventing a second visual language.

---

## Component Specs

### 1. Inbox tab + undoned badge

| Item | Spec |
|------|------|
| Label | **Inbox** (replaces Issues). Tab order: Feedback · Repos · **Inbox** · Leaderboard. |
| Badge | Count of **not-done** notifications under **active filters** (same query as list). Hide when 0. |
| Placement | Inline after tab label, not a second line. |
| Visual | Pill: `font-size: 11px; font-weight: 600; min-width: 18px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--accent-green); color: var(--bg);` Align with tab text baseline via flex. |
| Cap | Show `99+` above 99. |
| States | Unselected tab: muted label + still-visible green badge (attention). Selected: green bottom border + full text. |
| Live update | Badge refreshes with list fetch / soft poll while Inbox focused. |

### 2. Mode strip

Reuse `.glass-issues-modes` / pressed-pill pattern.

**Order (fixed):** Notifications · Work · Mergeable · All local · This repo  
**Default on open:** Notifications.

| State | Visual |
|-------|--------|
| Default | Border + muted text |
| Hover | `--text` + hover overlay |
| Pressed | `--accent-green` fill, `--bg` text, `font-weight: 600` |
| Focus | 2px `--focus-ring`, offset 2px |

Toolbar row: modes left; Refresh icon-btn right (existing issues refresh). Below modes: mode-specific chips/filters only (no cross-mode clutter).

### 3. Notifications mode

**Chips** (`.glass-chip`, `aria-pressed`):

| Chip | Default | Query effect |
|------|---------|--------------|
| Local | ON | `localOnly=1` |
| CI | OFF | `includeCi` |
| Bots | OFF | `includeBots` |
| Watching | OFF | `includeWatching` |
| Account | All | Select/chip-cycle of known accounts; default All |

Chip row under mode strip; optional trailing count on Local when filtered.

**Grouping:** Sticky-feel section headers by reason order: Review · Assign · Mention · Author · CI · Bot · Watching · Subscribed · Other. Header: `12px`, `font-weight: 600`, uppercase optional letter-spacing, `--muted`, top padding 16px / bottom 6px, count in muted mono.

**Row** (extend `.glass-issue-row`):

```
[☐] [GH|GL] owner/repo · subjectType
Title (link)                          · relative time
reason pill · account · unread dot
```

| State | Treatment |
|-------|-----------|
| Unread | Full opacity; 6px accent-blue dot (or left border 2px blue) |
| Read | `opacity: 0.62`; no unread indicator |
| Done | Removed from list (not-done = inbox) |
| Selected | `outline: 2px solid var(--focus-ring); outline-offset: -2px` OR left border green — keyboard focus ring mandatory |
| Hover | `--hover-overlay` |
| Multi-selected | Subtle green-tinted border / checkbox checked |

**Bulk bar** (fixed under toolbar when ≥1 selected): left `N selected` + Clear; right Done · Mark read · Mute (Mute disabled if any selected row is GL / `muteSupported=false`). Bar height ~40px, surface bg, top border. Unselect clears bar.

**Row actions** (hover / focus overflow or icon strip): Done · Read/Unread · Mute (hidden/disabled GL) · Open host. Primary path remains open-on-host for real work.

**Empty:** “Inbox zero — nothing undoned under these filters.” Hint to flip CI/Watching if empty feels wrong.

**Fail banner:** Reuse collapsible soft-fail list (per account/host).

### 4. Work mode

No soft-triage bulk/keys. Open-on-host only.

**Sections** (headers as Notifications): Reviews → Assigned → Author → Mention → Other. Within section: newest first.

**Row affordance PR vs issue:**

| Kind | Mark |
|------|------|
| PR | Pill `PR` purple border/text (`--purple`) |
| Issue | Pill `Issue` muted border (or omit if number alone is enough; prefer explicit PR) |

Meta: attention reason, host, repo, `#n`, author, updated. Title is external link. No checkboxes.

### 5. Mergeable mode

Ship queue — not triage.

**Sections:** Ready (top) · Blocked (below). Ready rows use green left border (`#00A64A` / accent-green); blocked use warning or neutral.

**Ready row:**

```
[GH|GL] owner/repo #n · author
Title
✓ Checks · ✓ Approved · ✓ Up to date     [Merge] [Open]
```

**Blocked row:** Same grid; reasons as warning chips (`reasons[]` e.g. “Checks failing”, “Needs approval”, “Behind base”). Primary button disabled or replaced with “Open” only; no Merge CTA when `ready=false`.

**Primary action:** single **Merge** button (green outline like `.glass-push-btn` / green action) → opens confirm modal. Never bulk.

**Empty Ready:** “Nothing ready to ship.” Blocked may still list.

### 6. Merge confirm modal

Reuse `.glass-modal-overlay` / `.glass-modal`; max-width **560px** (between default 480 and commit 720).

**Structure:**

1. **Title:** Merge `owner/repo#n`
2. **Status strip** (after live `GET /api/mergeable/status`): horizontal pills — Checks · Approval · Behind. Green = pass, red/warn = fail. If not ready: banner “No longer ready — …” and disable Merge.
3. **Method** `<select>`: only `allowedMethods`; preselect `defaultMethod` (remembered per repo).
4. **Commit title** input; **body** textarea — prefilled from host defaults; monospace optional on body.
5. **Delete branch note** (read-only muted line): “Head branch will be deleted” / “Branch kept” from `deleteBranchDefault` — **no checkbox** (host/repo policy).
6. **Actions:** Cancel (ghost) · **Merge** (green solid). Loading: Merge → spinner, disable both until settle.

| Modal state | Merge button |
|-------------|--------------|
| Fetching status | Disabled + “Checking…” |
| Ready | Enabled |
| Not ready / error | Disabled; status strip + message explain |
| Merging | Disabled spinner |
| Success | Close modal; toast success; remove/refresh row |

**Enter:** focuses/opens confirm only when row focused in list — **never** merges from list. Inside modal, Enter on Merge only if enabled and focus is on Merge (standard form: avoid accidental merge from title field — prefer explicit button activate; Ctrl/Cmd+Enter optional, not required).

Esc / overlay click = cancel (no merge). Focus trap; restore focus to row on close.

### 7. All local · This repo

Preserve existing Issues filters (state, host, repo, labels, …) and row chrome. Only rename parent tab/view shell to Inbox. Modes switch content; filters panel shows only for these two modes.

### 8. Keyboard focus ring on list rows

All interactive list rows (`role="option"` or `role="row"` in listbox/grid):

- Focusable: `tabindex="0"` on focused item; others `-1` with roving tabindex **or** single `aria-activedescendant` on list.
- Visible ring: `outline: 2px solid var(--focus-ring); outline-offset: -2px` (matches tab inset style). Never `outline: none` without replacement.
- j/k moves focus + scrolls into view (`scrollIntoView({ block: "nearest" })`).

---

## User Stories

Base URL: `http://127.0.0.1:7777`

1. **Tab rename** — Open app → tab bar shows **Inbox** (not Issues). Click Inbox → default mode **Notifications**.
2. **Badge** — With undoned notifs under default filters, green count on Inbox tab. Mark all done → badge hides.
3. **Default filters** — Notifications shows Local on; CI/Bots/Watching off. Toggle CI → CI-group rows appear when present.
4. **Dim read** — Unread row full strength; mark read (u or action) → row dims, stays until Done.
5. **Done** — Select row, press **e** or bulk Done → row leaves list; badge decrements.
6. **Group headers** — List shows reason sections (Review first when present).
7. **Bulk** — Shift/click multi-select → bulk bar → Done/Read; Mute greyed if selection includes GitLab.
8. **Work mode** — Mode Work → sections Reviews then Assigned; PR pill vs Issue; click title opens host; no bulk bar.
9. **Mergeable list** — Mode Mergeable → Ready above Blocked; blocked shows reason chips; only Ready has Merge.
10. **Confirm + live check** — Merge on Ready → modal status strip loads → method/title/body editable → Merge succeeds → toast; PR gone/refreshed. If re-fetch not ready → Merge disabled with explanation.
11. **No accidental merge** — Focus Ready row, press Enter → modal opens; merge does **not** fire until explicit Merge in modal.
12. **Keyboard notifs** — j/k move; o opens host; m mute (GH); u unread; e done. Keys inert in Work/Mergeable except j/k/o/Enter(open confirm on Mergeable).
13. **Soft poll** — Stay on Inbox Notifications ~2–5m → list/badge refresh without full navigation.
14. **This repo / All local** — Modes still list issues for local remotes / selected repo as today.

---

## Accessibility Requirements

| Area | Requirement |
|------|-------------|
| Tab | `role="tab"`, `aria-selected`, `aria-controls="view-inbox"`. Badge: `aria-label="Inbox, N unread threads"` (or undoned). |
| Modes | `role="toolbar"` + buttons `aria-pressed`. |
| Chips | `aria-pressed` toggle; Account control labeled “Account filter”. |
| Lists | `aria-label` per mode (“Notifications”, “Mergeable pull requests”). Announce group headers as non-focusable headings (`h3` or `role="heading" aria-level="3"`). |
| Rows | Checkbox has name “Select {title}”. Title link clear name. Host badge not sole color cue (text GH/GL). |
| Keyboard Notifications | **j/k** move · **x** or space toggle select · **e** done · **o** open · **m** mute · **u** unread · **Shift+j/k** extend selection optional. Ignore when focus in input/select/textarea. |
| Keyboard Mergeable | **j/k** · **o** open host · **Enter** open confirm only. **No** single-key merge. |
| Modal | `role="dialog" aria-modal="true" aria-labelledby`. Focus trap; initial focus method or Merge if ready. Esc closes. Live status region `aria-live="polite"`. Disabled Merge: `aria-disabled` + visible reason. |
| Contrast | Text/muted on surface ≥ WCAG AA; green badge on tab: green fill + dark text meets AA. Focus ring 2px non-color-only. |
| Reduced motion | No required animation; spinners ok; respect `prefers-reduced-motion` if pulse used. |
| Touch | Mode pills and Merge ≥ 32px height; checkbox hit ≥ 24px. |

---

## Engineer notes (non-visual)

- Soft poll only while `#view-inbox` visible and document focused.
- Mute control: omit or disabled + title “Mute not available on GitLab”.
- Merge method memory: last choice per `host/owner/repo` in `localStorage` key `glass.mergeMethod.*`.
- Bump `CACHE_VERSION` on `app.html` change.

**Out of v1 UI:** in-Glass review/comment, bulk merge, delete-branch checkbox, admin bypass, auto-merge toggle, Saved/pin.
