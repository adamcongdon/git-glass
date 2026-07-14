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

// ─── Self-update ────────────────────────────────────────────────────────────
//
// The updater targets the latest release *tag* directly rather than running a
// bare `git pull`. A bare pull advances only the current branch's upstream, so
// it silently reports "Already up to date" whenever the checkout is on a branch
// that doesn't contain the release (e.g. `dev`), and errors outright on a branch
// with no tracking info. Fast-forwarding to the release commit works regardless
// of branch/tracking state and lets us report a clear reason when it can't.

export type SelfUpdateStatus =
  | "already-current"
  | "fast-forward"
  | "cannot-fast-forward"
  | "unavailable";

export interface SelfUpdatePlan {
  status: SelfUpdateStatus;
  message: string;
}

// Pure decision function — given the facts gathered from git, decide what to do.
// Exported so the branching logic can be unit-tested without spawning git.
export function planSelfUpdate(input: {
  latestTag: string | null;      // GitHub "latest release" tag_name, or null if the check failed
  tagCommit: string | null;      // commit the tag resolves to locally, or null if unresolved
  headCommit: string | null;     // current HEAD commit, or null if rev-parse failed
  branch: string | null;         // current branch; "HEAD" or empty means detached
  tagIsAncestorOfHead: boolean;  // HEAD already contains the release commit (at or ahead)
  headIsAncestorOfTag: boolean;  // a fast-forward to the release is possible
}): SelfUpdatePlan {
  const { latestTag, tagCommit, headCommit, branch, tagIsAncestorOfHead, headIsAncestorOfTag } = input;

  if (!latestTag) {
    return {
      status: "unavailable",
      message: "Couldn't determine the latest release — the GitHub check failed. Try again shortly.",
    };
  }
  if (!headCommit) {
    return {
      status: "unavailable",
      message: "Couldn't resolve the current commit (git rev-parse HEAD failed).",
    };
  }
  if (!tagCommit) {
    return {
      status: "unavailable",
      message: `Release ${latestTag} isn't available locally even after fetching. Check remote access and try again.`,
    };
  }
  if (tagIsAncestorOfHead) {
    return { status: "already-current", message: `Already on ${latestTag} (or newer). Nothing to update.` };
  }
  if (headIsAncestorOfTag) {
    return { status: "fast-forward", message: `Fast-forwarding to ${latestTag}.` };
  }
  const where = branch && branch !== "HEAD" ? `branch "${branch}"` : "a detached HEAD";
  return {
    status: "cannot-fast-forward",
    message:
      `Can't fast-forward to ${latestTag}: your checkout (${where}) has diverged from the release ` +
      `commit and can't be advanced automatically. Switch to the release branch and reset to it ` +
      "(e.g. `git checkout main && git fetch && git reset --hard origin/main`), then restart.",
  };
}

export interface SelfUpdateResult {
  ok: boolean;        // repo is now at the latest release (either moved to it or already there)
  changed: boolean;   // HEAD actually moved — the caller should restart to load the new code
  status: SelfUpdateStatus | "error";
  target: string | null; // the release tag we aimed for
  message: string;
}

// Spawn git in `repoDir`, capturing exit code + combined stdout/stderr, with a hard
// timeout. Credential prompts are disabled so a fetch against a remote fails fast
// instead of hanging. Never throws — a spawn error or timeout becomes a non-zero code.
async function gitSpawn(
  repoDir: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs),
    );
    const [out, err] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
      timer,
    ]);
    const code = await proc.exited;
    return { code, out: [out, err].filter(Boolean).join("\n").trim() };
  } catch (err: any) {
    return { code: 1, out: String(err?.message ?? err) };
  }
}

// Convenience wrapper for git commands whose trimmed stdout is the value we want.
// Returns null on any non-zero exit or empty output.
async function gitSpawnOut(repoDir: string, args: string[]): Promise<string | null> {
  const { code, out } = await gitSpawn(repoDir, args, 10_000);
  return code === 0 && out ? out.trim() : null;
}

// Fast-forward the dashboard's own checkout to the latest GitHub release tag.
// `repoDir` is supplied by the caller (index.ts owns SELF_REPO_DIR, captured at
// module load) so it can't be redirected by config or a request body.
export async function performSelfUpdate(repoDir: string): Promise<SelfUpdateResult> {
  const info = await getVersionInfo(true); // force a fresh check — never act on stale version data
  const latestTag = info.latest;

  // Best-effort: fetch tags so the release commit is resolvable locally. A failure
  // here isn't fatal on its own — the tag may already be present from a prior fetch.
  await gitSpawn(repoDir, ["fetch", "--tags", "--force", "origin"]);

  const headCommit = await gitSpawnOut(repoDir, ["rev-parse", "HEAD"]);
  const branch = await gitSpawnOut(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const tagCommit = latestTag
    ? await gitSpawnOut(repoDir, ["rev-parse", "--verify", "--quiet", `${latestTag}^{commit}`])
    : null;

  const tagIsAncestorOfHead =
    !!(tagCommit && headCommit) &&
    (await gitSpawn(repoDir, ["merge-base", "--is-ancestor", tagCommit, headCommit])).code === 0;
  const headIsAncestorOfTag =
    !!(tagCommit && headCommit) &&
    (await gitSpawn(repoDir, ["merge-base", "--is-ancestor", headCommit, tagCommit])).code === 0;

  const plan = planSelfUpdate({
    latestTag,
    tagCommit,
    headCommit,
    branch,
    tagIsAncestorOfHead,
    headIsAncestorOfTag,
  });

  if (plan.status === "fast-forward" && tagCommit) {
    const ff = await gitSpawn(repoDir, ["merge", "--ff-only", tagCommit]);
    if (ff.code === 0) {
      return { ok: true, changed: true, status: "fast-forward", target: latestTag, message: `Updated to ${latestTag}.` };
    }
    return {
      ok: false,
      changed: false,
      status: "error",
      target: latestTag,
      message: `Fast-forward to ${latestTag} failed: ${ff.out || "git merge --ff-only returned a non-zero exit."}`,
    };
  }

  return {
    ok: plan.status === "already-current",
    changed: false,
    status: plan.status,
    target: latestTag,
    message: plan.message,
  };
}
