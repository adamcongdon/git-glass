/**
 * lib/leaderboard.ts
 *
 * Pure logic + git-driven data fetch for the Leaderboard tab.
 *
 * Activity score formula:
 *   if commits === 0 → score = 0
 *   else:
 *     halfLife = windowDays === 'all' ? 30 : max(windowDays / 4, 3)
 *     daysSinceLast = (now - lastCommitDate) / 86400000
 *     score = commits*10 + filesChanged*1 + (additions+deletions)*0.05
 *           + 50 * exp(-daysSinceLast / halfLife)
 *
 * Commits dominate (10pt each). File breadth + line volume add nuance.
 * Recency bonus rewards "still active" over "burst-and-stopped" (max 50pt).
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { runGit, getGitRepos, pMap } from "./gitStatus";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WindowLabel = "7d" | "30d" | "90d" | "all";
export type WindowDays = number | "all";

export interface ParsedWindow {
  days: WindowDays;
  label: WindowLabel;
}

export interface RepoActivityStats {
  commits: number;
  additions: number;
  deletions: number;
  filesChanged: number;
  lastCommitDate: string;
  lastCommitSha: string;
}

export interface RepoLeaderboardEntry extends RepoActivityStats {
  name: string;
  path: string;
  score: number;
  /** Month-to-date Claude API spend in cents for this repo, sourced from PAI usage cache. 0 if absent. */
  claudeCostCents: number;
  error?: string;
}

export interface LeaderboardResult {
  window: WindowLabel;
  windowDays: WindowDays;
  generatedAt: string;
  totalRepos: number;
  repos: RepoLeaderboardEntry[];
}

export interface LeaderboardConfig {
  scanPaths: string[];
  ignoredRepos: string[];
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  stats: RepoActivityStats;
  computedAt: string;
}

// Key: `${windowLabel}::${repoPath}::${lastCommitSha}`
const activityCache = new Map<string, CacheEntry>();
const CACHE_MAX_ENTRIES = 500;

// ─── Score formula weights ───────────────────────────────────────────────────

const COMMIT_WEIGHT = 10;
const FILE_WEIGHT = 1;
const LINE_WEIGHT = 0.05;
const RECENCY_MAX = 50;
const HALF_LIFE_ALL = 30;
const HALF_LIFE_FLOOR = 3;

// ─── Claude cost (PAI usage-cache) ────────────────────────────────────────────

/**
 * PAI's statusline writes month-to-date Claude API cost per project to
 * `$PAI_DIR/MEMORY/STATE/usage-cache.json` under `project_costs.month_used_cents`.
 * The slug = repo absolute path with `/` and `.` replaced by `-`.
 */
export function slugifyPath(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

export async function getClaudeCostMap(): Promise<Record<string, number>> {
  const paiDir = process.env.PAI_DIR ?? join(homedir(), ".claude");
  const cachePath = join(paiDir, "MEMORY", "STATE", "usage-cache.json");
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    const map = parsed?.project_costs?.month_used_cents;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

// ─── parseWindow ─────────────────────────────────────────────────────────────

const VALID_WINDOWS: Record<string, ParsedWindow> = {
  "7d":  { days: 7,     label: "7d"  },
  "30d": { days: 30,    label: "30d" },
  "90d": { days: 90,    label: "90d" },
  "all": { days: "all", label: "all" },
};

/**
 * Parses a window string into { days, label }.
 * Defaults to '30d' when input is undefined.
 * Throws on invalid input.
 */
export function parseWindow(input: string | undefined): ParsedWindow {
  if (input === undefined) return VALID_WINDOWS["30d"];
  const result = VALID_WINDOWS[input];
  if (!result) {
    throw new Error(
      `Invalid window "${input}". Must be one of: 7d, 30d, 90d, all.`
    );
  }
  return result;
}

// ─── scoreActivity ────────────────────────────────────────────────────────────

/**
 * Computes the composite activity score for a repo in a given window.
 *
 * @param stats       - The aggregated git statistics for the repo.
 * @param windowDays  - Number of days in the window, or 'all'.
 * @param now         - Injectable "current time" for deterministic tests (default: new Date()).
 * @returns           - Numeric score >= 0.
 */
export function scoreActivity(
  stats: RepoActivityStats,
  windowDays: WindowDays,
  now: Date = new Date()
): number {
  if (stats.commits === 0) return 0;

  const halfLife =
    windowDays === "all"
      ? HALF_LIFE_ALL
      : Math.max((windowDays as number) / 4, HALF_LIFE_FLOOR);

  const daysSinceLast =
    (now.getTime() - new Date(stats.lastCommitDate).getTime()) / 86400000;

  const recencyBonus = RECENCY_MAX * Math.exp(-daysSinceLast / halfLife);

  return (
    stats.commits * COMMIT_WEIGHT +
    stats.filesChanged * FILE_WEIGHT +
    (stats.additions + stats.deletions) * LINE_WEIGHT +
    recencyBonus
  );
}

// ─── getRepoActivity ──────────────────────────────────────────────────────────

/**
 * Fetches git activity stats for a single repo.
 *
 * Runs `git log` with `--numstat` to count commits, sum insertions/deletions,
 * and count unique files changed. When sinceISO is null, fetches all history
 * (the 'all' window).
 *
 * Uses in-memory cache keyed by `${label}::${repoPath}::${lastCommitSha}`.
 * The cheap `git rev-parse HEAD` check comes first to decide cache hit.
 */
export async function getRepoActivity(
  repoPath: string,
  sinceISO: string | null
): Promise<RepoActivityStats> {
  // Get current HEAD sha cheaply for cache key
  const currentSha = await runGit(repoPath, ["rev-parse", "HEAD"]).catch(() => "");

  // Build a cache key. Use sinceISO as part of the key (null → "all").
  const cacheKey = `${sinceISO ?? "all"}::${repoPath}::${currentSha}`;
  const cached = activityCache.get(cacheKey);
  if (cached) return cached.stats;

  const args: string[] = [
    "log",
    "--pretty=format:COMMIT|%H|%cI",
    "--numstat",
  ];
  if (sinceISO !== null) {
    args.push(`--since=${sinceISO}`);
  }

  const raw = await runGit(repoPath, args);

  // Parse output:
  // COMMIT|<sha>|<iso-date>
  // <additions>\t<deletions>\t<filename>   (numstat lines, one per changed file)
  // (blank line between commits)
  let commits = 0;
  let additions = 0;
  let deletions = 0;
  const changedFiles = new Set<string>();
  let lastCommitDate = "";
  let lastCommitSha = "";
  let firstCommitSeen = false;

  if (raw) {
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.startsWith("COMMIT|")) {
        const parts = line.split("|");
        // parts[1] = sha, parts[2] = iso date
        commits++;
        if (!firstCommitSeen) {
          // git log outputs newest first
          lastCommitSha = parts[1] ?? "";
          lastCommitDate = parts[2] ?? "";
          firstCommitSeen = true;
        }
      } else if (line.trim() === "") {
        continue;
      } else {
        // numstat line: "<adds>\t<dels>\t<filename>"
        // Binary files show "-\t-\t<filename>"
        const parts = line.split("\t");
        if (parts.length >= 3) {
          const addStr = parts[0].trim();
          const delStr = parts[1].trim();
          const filename = parts.slice(2).join("\t").trim();
          if (filename) changedFiles.add(filename);
          if (addStr !== "-") additions += parseInt(addStr, 10) || 0;
          if (delStr !== "-") deletions += parseInt(delStr, 10) || 0;
        }
      }
    }
  }

  const stats: RepoActivityStats = {
    commits,
    additions,
    deletions,
    filesChanged: changedFiles.size,
    lastCommitDate,
    lastCommitSha: currentSha || lastCommitSha,
  };

  if (activityCache.size >= CACHE_MAX_ENTRIES) activityCache.clear();
  activityCache.set(cacheKey, { stats, computedAt: new Date().toISOString() });
  return stats;
}

// ─── getLeaderboard ──────────────────────────────────────────────────────────

/**
 * Scans all repos from config, fetches activity stats, scores them,
 * and returns a sorted leaderboard result.
 *
 * Per-repo errors are caught and surfaced as an `error` field on that
 * repo entry only — never propagates to crash the entire response.
 */
export async function getLeaderboard(
  config: LeaderboardConfig,
  windowInput: string | undefined
): Promise<LeaderboardResult> {
  const { days, label } = parseWindow(windowInput);

  // Compute the --since ISO date (null → 'all' window, omit --since flag)
  const sinceISO: string | null =
    days === "all"
      ? null
      : new Date(Date.now() - (days as number) * 86400000).toISOString();

  const [repos, costMap] = await Promise.all([
    getGitRepos(config.scanPaths, config.ignoredRepos),
    getClaudeCostMap(),
  ]);

  const entries = await pMap(
    repos,
    async (repo) => {
      const claudeCostCents = costMap[slugifyPath(repo.path)] ?? 0;
      try {
        const stats = await getRepoActivity(repo.path, sinceISO);
        const score = scoreActivity(stats, days);
        const entry: RepoLeaderboardEntry = {
          name: repo.name,
          path: repo.path,
          ...stats,
          score,
          claudeCostCents,
        };
        return entry;
      } catch (e: any) {
        const entry: RepoLeaderboardEntry = {
          name: repo.name,
          path: repo.path,
          commits: 0,
          additions: 0,
          deletions: 0,
          filesChanged: 0,
          lastCommitDate: "",
          lastCommitSha: "",
          score: 0,
          claudeCostCents,
          error: e.message ?? "Unknown error",
        };
        return entry;
      }
    },
    8
  );

  // Sort by score desc, then lastCommitDate desc
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Fall back to lastCommitDate descending
    const dateA = a.lastCommitDate ? new Date(a.lastCommitDate).getTime() : 0;
    const dateB = b.lastCommitDate ? new Date(b.lastCommitDate).getTime() : 0;
    return dateB - dateA;
  });

  return {
    window: label,
    windowDays: days,
    generatedAt: new Date().toISOString(),
    totalRepos: repos.length,
    repos: entries,
  };
}
