---
task: Produce Glass UI/UX spec for Engineer implementation
slug: 20260513-000001_glass-designer-ui-spec
effort: standard
phase: complete
progress: 20/20
mode: interactive
started: 2026-05-13T00:00:01Z
updated: 2026-05-13T00:00:10Z
---

## Context

Designer agent producing a concrete UI/UX specification for the Glass app (feedback-tool + git-status-dashboard merger). The Engineer will implement everything inside /Users/adam.congdon/code/feedback-tool/public/app.html. No bundler; all CSS inline. Existing CSS uses GitHub-dark palette; migrating to Veeam brand. New classes prefixed glass-. Deliverable is spec only, not implementation.

### Risks
- Veeam Green #00D15F fails 4.5:1 on dark surfaces for small text — must call this out per token
- Existing .card, .btn-green etc. classes must not be touched; glass- prefix isolates new work
- Reduced motion must cover spinner, slide animations, tab transitions
- Focus trap in three modals must be fully specified or Engineer will miss it

## Criteria

- [x] ISC-1: Palette migration table lists all 9 existing CSS vars with old and new values
- [x] ISC-2: Each palette entry includes a one-line WCAG contrast note with ratio
- [x] ISC-3: Three new vars documented: --accent-green-hover, --warning, --info
- [x] ISC-4: Typography section specifies font stack without CDN import rationale
- [x] ISC-5: Type scale table covers all 6 levels (H1-H3, body, small, code)
- [x] ISC-6: Tab bar DOM structure specified with correct ARIA roles and attributes
- [x] ISC-7: All four tab states specified with colors and pixel measurements
- [x] ISC-8: Tab indicator choice documented with rationale
- [x] ISC-9: Keyboard behavior specified (Arrow L/R, Cmd+1/2, Tab focus)
- [x] ISC-10: Repos toolbar lists all five controls with enable/disable conditions
- [x] ISC-11: Filter chips use role=group + aria-pressed on each button
- [x] ISC-12: Repo grid CSS spec given (auto-fill, minmax, gap)
- [x] ISC-13: Repo card spec covers header, badges, sub-info, and action row
- [x] ISC-14: Badge color coding table covers all 5 status types
- [x] ISC-15: All three modals specify focus trap, initial focus, and return-focus target
- [x] ISC-16: Banner spec includes aria-live, three color variants, reduced-motion behavior
- [x] ISC-17: Focus/keyboard table lists every focusable element in Repos view
- [x] ISC-18: CSS sketch provided for glass-tab, glass-repo-card, glass-chip
- [x] ISC-19: prefers-reduced-motion wrapper present in CSS sketch
- [x] ISC-20: All 7 user stories re-stated with testability confirmation and screenshot description

## Decisions

## Verification
