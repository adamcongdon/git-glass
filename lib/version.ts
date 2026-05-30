// Provides version/update-check logic for Git Glass.
// Uses `git describe` for the local version and the GitHub releases API
// for the latest published tag, with a 60-second in-process cache.

import { join } from "path";
import { readConfig } from "./config";
import { getGhToken } from "./gh";

const REPO_DIR = join(import.meta.dir, "..");
const GITHUB_REPO = "adamcongdon/git-glass";
const CACHE_TTL = 60_000;
const GITHUB_TIMEOUT_MS = 5_000;

export interface VersionInfo {
  current: string;        // `git describe --tags --always` output (e.g. "v0.1.0", "v0.1.0-3-gabcdef", or a bare SHA)
  latest: string | null;  // latest GitHub release `tag_name`, or null if check failed
  updateAvailable: boolean;
  currentCommit: string;  // `git rev-parse --short HEAD`
  changelog: string | null; // truncated GitHub release `body`, or null if unavailable
}

interface CachedVersionInfo extends VersionInfo {
  expiresAt: number;
}

const CHANGELOG_MAX_CHARS = 1200;
const CHANGELOG_TRUNCATED_SUFFIX = "\n…[truncated]";

let _cache: CachedVersionInfo | null = null;

// Test-only helper to drop the in-process cache between unit tests. Not part of
// the public runtime contract — only `tests/version.test.ts` should call this.
export function _resetVersionCacheForTesting(): void {
  _cache = null;
}

// Run a short git command and capture stdout. Returns null on any failure
// (non-zero exit, spawn error, etc) so callers can fall back to a default.
async function runGit(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: REPO_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

// Compare two semver-ish strings like "v0.1.0". Returns true if `latest` > `current`.
// Only the base "vMAJOR.MINOR.PATCH" prefix is parsed — anything after (e.g. "-3-gabcdef")
// is ignored, which is the correct behavior for a local commit that's ahead of a release tag
// (we treat ahead-of-release as "up to date", because `latest` cannot be newer than ourselves).
// Exported so unit tests can exercise edge cases without relying on `getVersionInfo` plumbing.
export function isNewerTag(latest: string, current: string): boolean {
  const re = /^v?(\d+)\.(\d+)\.(\d+)/;
  const lMatch = latest.match(re);
  const cMatch = current.match(re);
  if (!lMatch || !cMatch) return false;
  const lMaj = Number(lMatch[1]);
  const lMin = Number(lMatch[2]);
  const lPatch = Number(lMatch[3]);
  const cMaj = Number(cMatch[1]);
  const cMin = Number(cMatch[2]);
  const cPatch = Number(cMatch[3]);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

// `force=true` bypasses the cache read but still writes the fresh result back,
// so a forced check warms the cache for subsequent non-forced reads.
export async function getVersionInfo(force = false): Promise<VersionInfo> {
  if (!force && _cache && Date.now() < _cache.expiresAt) {
    const { expiresAt: _expiresAt, ...info } = _cache;
    return info;
  }

  const describe = await runGit(["describe", "--tags", "--always"]);
  const current = describe ?? "unknown";

  const shortSha = await runGit(["rev-parse", "--short", "HEAD"]);
  const currentCommit = shortSha ?? "";

  let latest: string | null = null;
  let changelog: string | null = null;
  try {
    const headers: Record<string, string> = {
      "User-Agent": "git-glass",
      Accept: "application/vnd.github+json",
    };

    // Best-effort auth: a token raises the GitHub API rate limit from 60/hr to 5000/hr.
    // If the user has no GitHub account configured, or token retrieval fails, we silently
    // fall back to the unauthenticated request — never crash here.
    try {
      const cfg = await readConfig();
      const account =
        cfg.github.defaultAccount || Object.values(cfg.github.ownerAccounts)[0];
      if (account) {
        try {
          const token = await getGhToken(account);
          if (token) headers.Authorization = `Bearer ${token}`;
        } catch {
          // gh token not retrievable — proceed unauthenticated
        }
      }
    } catch {
      // config unreadable — proceed unauthenticated
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GITHUB_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers, signal: ctrl.signal },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { tag_name?: string; body?: string };
        latest = data.tag_name ?? null;
        // Capture the release body for the update modal. Truncate aggressively
        // — the modal scrolls but we don't want to ship 50KB of markdown to the
        // client for every poll. Null on missing/empty so the UI can render a
        // friendly "No changelog available." fallback.
        if (typeof data.body === "string" && data.body.length > 0) {
          changelog =
            data.body.length > CHANGELOG_MAX_CHARS
              ? data.body.slice(0, CHANGELOG_MAX_CHARS) + CHANGELOG_TRUNCATED_SUFFIX
              : data.body;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network failure, abort, or JSON parse error — leave latest and changelog as null.
    latest = null;
    changelog = null;
  }

  let updateAvailable = false;
  if (latest && current !== "unknown") {
    const currentBase = current.match(/^(v\d+\.\d+\.\d+)/)?.[1] ?? null;
    if (currentBase) {
      updateAvailable = isNewerTag(latest, currentBase);
    }
    // If currentBase is null (bare SHA / no tag in history), we can't compare safely,
    // so updateAvailable stays false.
  }

  const result: VersionInfo = { current, latest, updateAvailable, currentCommit, changelog };
  _cache = { ...result, expiresAt: Date.now() + CACHE_TTL };
  return result;
}
