import { readdir, stat } from "fs/promises";
import { realpathSync } from "fs";
import { join, resolve } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepoInfo {
  name: string;
  path: string;
  folder: string;
}

export interface BranchInfo {
  name: string;
  upstream: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface RepoStatus {
  name: string;
  path: string;
  folder: string;
  branch: string;
  uncommitted: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  detached: boolean;
  lastCommitDate: string;
  branches: BranchInfo[];
  remoteUrl: string;
  error?: string;
}

// ─── Path validation ─────────────────────────────────────────────────────────

function realOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function validateRepoPath(
  rawPath: unknown,
  scanPaths: string[],
): { resolved: string } | { error: string; status: number } {
  if (!rawPath || typeof rawPath !== "string" || rawPath.includes("..") || rawPath.trim() === "") {
    return { error: "Invalid path", status: 400 };
  }
  const resolved = realOrResolve(rawPath);
  const allowed = scanPaths.some((dir) => resolved.startsWith(realOrResolve(dir) + "/"));
  if (!allowed) {
    return { error: "Path not in configured directories", status: 403 };
  }
  return { resolved };
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

/**
 * Parses the output of `git rev-list --left-right --count <branch>...<upstream>`
 * which is "ahead\tbehind". Returns { ahead, behind } with zeros on any error.
 */
export function parseAheadBehind(raw: string): { ahead: number; behind: number } {
  if (!raw) return { ahead: 0, behind: 0 };
  const parts = raw.split("\t");
  if (parts.length !== 2) return { ahead: 0, behind: 0 };
  const ahead = parseInt(parts[0], 10);
  const behind = parseInt(parts[1], 10);
  if (isNaN(ahead) || isNaN(behind)) return { ahead: 0, behind: 0 };
  return { ahead, behind };
}

/**
 * Parses the output of:
 *   git for-each-ref --format=%(refname:short)|%(upstream:short)|%(upstream:track) refs/heads/
 *
 * Each line is: branchName|upstreamRef|[ahead N, behind M]  (or [gone])
 * Returns array of BranchInfo. Skips blank lines; ignores malformed lines silently.
 */
export function parseBranchRefs(raw: string): BranchInfo[] {
  if (!raw) return [];
  const results: BranchInfo[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [name, upstream, ...trackParts] = line.split("|");
    if (!name) continue;
    const track = trackParts.join("|");
    const info: BranchInfo = {
      name,
      upstream: upstream ?? "",
      ahead: 0,
      behind: 0,
      gone: false,
    };
    if (track === "[gone]") {
      info.gone = true;
    } else if (track) {
      const aheadMatch = track.match(/ahead (\d+)/);
      const behindMatch = track.match(/behind (\d+)/);
      if (aheadMatch) info.ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) info.behind = parseInt(behindMatch[1], 10);
    }
    results.push(info);
  }
  return results;
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

/**
 * Bounded-concurrency map. Processes `items` with `fn` using at most
 * `concurrency` simultaneous promises. Preserves input order in results.
 */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── Git runner ───────────────────────────────────────────────────────────────

/**
 * Runs a git command in a repo directory. Returns stdout trimmed.
 * Kills the process after 10s to avoid hangs on network operations.
 */
export async function runGit(repoPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
  });

  const textPromise = new Response(proc.stdout).text();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => {
        proc.kill();
        reject(new Error(`git ${args[0]} timed out after 10s`));
      },
      10_000,
    ),
  );

  const text = await Promise.race([textPromise, timeout]);
  await proc.exited;
  return text.trim();
}

// ─── Repo scanner ─────────────────────────────────────────────────────────────

/**
 * Depth-1 scan: lists direct subdirectories of each scanPath that contain
 * a `.git` directory. Filters out paths in `ignoredRepos` (after resolve()).
 * Returns repos sorted alphabetically by name.
 */
export async function getGitRepos(
  scanPaths: string[],
  ignoredRepos: string[],
): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];
  const ignoredSet = new Set(ignoredRepos.map((p) => resolve(p)));

  for (const dir of scanPaths) {
    const resolvedDir = resolve(dir);
    let entries;
    try {
      entries = await readdir(resolvedDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(resolvedDir, entry.name);
      const gitDir = join(fullPath, ".git");
      try {
        const s = await stat(gitDir);
        if (s.isDirectory()) {
          repos.push({ name: entry.name, path: fullPath, folder: resolvedDir });
        }
      } catch {
        // Not a git repo
      }
    }
  }

  const filtered = repos.filter((r) => !ignoredSet.has(r.path));
  return filtered.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// ─── Repo status ──────────────────────────────────────────────────────────────

/**
 * Fetches full git status for a single repo: branch, uncommitted count,
 * ahead/behind, last commit date, all branches, remote URL.
 */
export async function getRepoStatus(repo: RepoInfo): Promise<RepoStatus> {
  const repoPath = repo.path;
  const status: RepoStatus = {
    name: repo.name,
    path: repo.path,
    folder: repo.folder,
    branch: "",
    uncommitted: 0,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    detached: false,
    lastCommitDate: "",
    branches: [],
    remoteUrl: "",
  };

  try {
    const [branch, porcelain, remotes, lastLog, branchRefs, remoteUrl] = await Promise.all([
      runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(repoPath, ["status", "--porcelain"]),
      runGit(repoPath, ["remote"]),
      runGit(repoPath, ["log", "-1", "--format=%aI"]).catch(() => ""),
      runGit(repoPath, [
        "for-each-ref",
        "--format=%(refname:short)|%(upstream:short)|%(upstream:track)",
        "refs/heads/",
      ]).catch(() => ""),
      runGit(repoPath, ["remote", "get-url", "origin"]).catch(() => ""),
    ]);

    status.branch = branch;
    if (branch === "HEAD") status.detached = true;
    status.uncommitted = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
    status.hasRemote = remotes.length > 0;
    status.lastCommitDate = lastLog;
    status.remoteUrl = remoteUrl;
    status.branches = parseBranchRefs(branchRefs);

    // Ahead/behind for current branch
    if (status.hasRemote && !status.detached) {
      try {
        const upstream = await runGit(repoPath, [
          "rev-parse",
          "--abbrev-ref",
          `${branch}@{upstream}`,
        ]);
        if (upstream) {
          const aheadBehind = await runGit(repoPath, [
            "rev-list",
            "--left-right",
            "--count",
            `${branch}...${upstream}`,
          ]);
          const parsed = parseAheadBehind(aheadBehind);
          status.ahead = parsed.ahead;
          status.behind = parsed.behind;
        }
      } catch {
        // No upstream tracking branch — fine
      }
    }
  } catch (e: any) {
    status.error = e.message ?? "Unknown error";
  }

  return status;
}

/**
 * Scan all repos and fetch their status concurrently (up to 8 at a time).
 */
export async function getAllRepoStatuses(
  scanPaths: string[],
  ignoredRepos: string[],
): Promise<RepoStatus[]> {
  const repos = await getGitRepos(scanPaths, ignoredRepos);
  return pMap(repos, (repo) => getRepoStatus(repo), 8);
}
