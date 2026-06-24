# Changelog

All notable changes to Git Glass are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut automatically: the Release workflow derives the next version
from [Conventional Commit](https://www.conventionalcommits.org/) messages since
the last tag (`feat:` → minor, `fix:`/`perf:` → patch, `!`/`BREAKING CHANGE` →
major) and the git tag is the source of truth.

## v0.3.0 — 2026-06-24

### Added
- **Repo-routing learning** — Git Glass learns which repository a piece of
  feedback belongs to from your submissions and corrections, then biases (and,
  when confident, overrides) the AI's repo suggestion so you stop re-correcting
  the same misrouting. Includes a **Settings → Learned Routing** panel to view
  and delete learned examples.
- **Lens logo + full PWA icon set.**
- **Automatic versioning** — the Release workflow now computes the release
  version from Conventional Commit messages; no manual `package.json` bump.

### Changed
- Larger feedback textareas; original feedback text preserved through triage.

### Security
- Strip userinfo/embedded tokens from HTTPS remote-host parsing.

## v0.2.0 — 2026-05-30

### Added
- Socket security scanning in CI; CI + CodeQL gating before release.

### Changed
- Pin `zod` to v3; remove the unused `@anthropic-ai/sdk` dependency.

## v0.1.0 — 2026-05-29

- Initial release.
