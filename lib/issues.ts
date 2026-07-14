/**
 * lib/issues.ts
 *
 * Read-only issue listing across local clones (GitHub + GitLab).
 * Modes: mine | all | repo
 * Cache: short in-memory TTL; manual refresh invalidates via force flag.
 */

import { getGitRepos, pMap, runGit } from "./gitStatus";
import { parseRemoteUrl } from "./scanner";
import { getGhAccounts, getGhToken } from "./gh";
import type { Config } from "./config";
import { excludeHiddenRows } from "./inboxHide";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IssueMode = "mine" | "all" | "repo";
export type IssueStateFilter = "open" | "closed" | "all";
export type UpdatedPreset = "any" | "24h" | "7d" | "30d" | "90d";
export type HostFilter = "all" | "github" | "gitlab";
export type PriorityLevel = "high" | "medium" | "low";

export interface LocalRemote {
  name: string;
  path: string;
  remoteUrl: string;
  host: string;
  owner: string;
  repo: string;
  hostType: "github" | "gitlab";
}

export interface IssueRow {
  id: string;
  host: string;
  hostType: "github" | "gitlab";
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
  labels: string[];
  author: string | null;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  comments: number;
  milestone: string | null;
  priority: PriorityLevel | null;
  localPath: string | null;
}

export interface IssueFailure {
  path?: string;
  remote?: string;
  host: string;
  message: string;
}

export interface IssuesQuery {
  mode: IssueMode;
  state: IssueStateFilter;
  page: number;
  perPage: number;
  /** owner/repo — required for mode=repo; optional filter otherwise */
  repo?: string;
  host: HostFilter;
  label?: string;
  author?: string;
  assignee?: string;
  updated: UpdatedPreset;
  force?: boolean;
}

export interface IssuesResult {
  issues: IssueRow[];
  page: number;
  perPage: number;
  hasMore: boolean;
  totalMatched: number;
  generatedAt: string;
  cached: boolean;
  failures: IssueFailure[];
  remotes: Array<{
    name: string;
    path: string;
    host: string;
    owner: string;
    repo: string;
    hostType: "github" | "gitlab";
  }>;
  /** Count of hard-hidden repos in config (for empty-state affordance). */
  hiddenCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 90_000;
const PAGE_DEFAULT = 50;
const PER_REPO_FETCH_CAP = 40;
const MINE_SEARCH_PER_PAGE = 100;
const FETCH_CONCURRENCY = 6;

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheBag {
  issues: IssueRow[];
  failures: IssueFailure[];
  remotes: IssuesResult["remotes"];
  storedAt: number;
}

const listCache = new Map<string, CacheBag>();

export function clearIssuesCache(): void {
  listCache.clear();
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Map common priority labels → high | medium | low. */
export function inferPriorityFromLabels(labels: string[]): PriorityLevel | null {
  const normalized = labels.map((l) => l.trim().toLowerCase());
  for (const l of normalized) {
    if (
      /^(priority[:/\s-]*)?(p0|p1|critical|urgent|high)$/.test(l) ||
      l.includes("priority/high") ||
      l.includes("priority:high") ||
      l === "sev0" ||
      l === "sev1"
    ) {
      return "high";
    }
  }
  for (const l of normalized) {
    if (
      /^(priority[:/\s-]*)?(p2|medium|med|normal)$/.test(l) ||
      l.includes("priority/medium") ||
      l.includes("priority:medium") ||
      l === "sev2"
    ) {
      return "medium";
    }
  }
  for (const l of normalized) {
    if (
      /^(priority[:/\s-]*)?(p3|p4|p5|low|minor|trivial)$/.test(l) ||
      l.includes("priority/low") ||
      l.includes("priority:low") ||
      l === "sev3" ||
      l === "sev4"
    ) {
      return "low";
    }
  }
  return null;
}

/** Updated preset → minimum updatedAt ISO cutoff, or null for "any". */
export function updatedCutoffIso(preset: UpdatedPreset, nowMs = Date.now()): string | null {
  const hours: Record<Exclude<UpdatedPreset, "any">, number> = {
    "24h": 24,
    "7d": 24 * 7,
    "30d": 24 * 30,
    "90d": 24 * 90,
  };
  if (preset === "any") return null;
  const h = hours[preset];
  if (!h) return null;
  return new Date(nowMs - h * 3600_000).toISOString();
}

export function sortByUpdatedDesc(issues: IssueRow[]): IssueRow[] {
  return [...issues].sort((a, b) => {
    const tb = Date.parse(b.updatedAt) || 0;
    const ta = Date.parse(a.updatedAt) || 0;
    if (tb !== ta) return tb - ta;
    return b.number - a.number;
  });
}

export function dedupeIssues(issues: IssueRow[]): IssueRow[] {
  const seen = new Set<string>();
  const out: IssueRow[] = [];
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    out.push(issue);
  }
  return out;
}

export function filterIssues(
  issues: IssueRow[],
  opts: {
    host?: HostFilter;
    label?: string;
    author?: string;
    assignee?: string;
    updated?: UpdatedPreset;
    state?: IssueStateFilter;
    repoKey?: string; // owner/repo lowercase
    nowMs?: number;
  },
): IssueRow[] {
  const cutoff = updatedCutoffIso(opts.updated ?? "any", opts.nowMs ?? Date.now());
  const labelQ = opts.label?.trim().toLowerCase();
  const authorQ = opts.author?.trim().toLowerCase();
  const assigneeQ = opts.assignee?.trim().toLowerCase();
  const repoKey = opts.repoKey?.trim().toLowerCase();
  const host = opts.host ?? "all";
  const state = opts.state ?? "all";

  return issues.filter((issue) => {
    if (host !== "all" && issue.hostType !== host) return false;
    if (state !== "all" && issue.state !== state) return false;
    if (repoKey) {
      const key = `${issue.owner}/${issue.repo}`.toLowerCase();
      if (key !== repoKey) return false;
    }
    if (labelQ && !issue.labels.some((l) => l.toLowerCase() === labelQ || l.toLowerCase().includes(labelQ))) {
      return false;
    }
    if (authorQ && (issue.author ?? "").toLowerCase() !== authorQ) return false;
    if (assigneeQ && !issue.assignees.some((a) => a.toLowerCase() === assigneeQ)) return false;
    if (cutoff) {
      const u = Date.parse(issue.updatedAt);
      if (!u || u < Date.parse(cutoff)) return false;
    }
    return true;
  });
}

export function paginateIssues(
  issues: IssueRow[],
  page: number,
  perPage: number,
): { pageItems: IssueRow[]; hasMore: boolean; totalMatched: number } {
  const p = Math.max(1, page);
  const n = Math.max(1, Math.min(100, perPage));
  const start = (p - 1) * n;
  const pageItems = issues.slice(start, start + n);
  return {
    pageItems,
    hasMore: start + n < issues.length,
    totalMatched: issues.length,
  };
}

export function issueId(host: string, owner: string, repo: string, number: number): string {
  return `${host.toLowerCase()}:${owner}/${repo}#${number}`;
}

/**
 * GitHub search does not allow OR-ing qualifier:@me terms in one query
 * (422). Emit three separate queries and merge client-side.
 */
export function buildGitHubAttentionQueries(state: IssueStateFilter): string[] {
  const statePart =
    state === "open" ? "is:open" : state === "closed" ? "is:closed" : "";
  const base = ["is:issue", statePart].filter(Boolean).join(" ");
  return [
    `${base} assignee:@me`,
    `${base} author:@me`,
    `${base} mentions:@me`,
  ];
}

/** @deprecated use buildGitHubAttentionQueries — kept for tests/compat */
export function buildGitHubAttentionQuery(state: IssueStateFilter): string {
  return buildGitHubAttentionQueries(state).join(" | ");
}

export function remoteKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

// ─── Local remotes ────────────────────────────────────────────────────────────

export async function discoverLocalRemotes(
  scanPaths: string[],
  ignoredRepos: string[],
): Promise<LocalRemote[]> {
  const repos = await getGitRepos(scanPaths, ignoredRepos);
  const results = await pMap(
    repos,
    async (r): Promise<LocalRemote | null> => {
      let remoteUrl = "";
      try {
        remoteUrl = await runGit(r.path, ["remote", "get-url", "origin"]);
      } catch {
        return null;
      }
      const parsed = parseRemoteUrl(remoteUrl);
      if (!parsed) return null;
      const hostLower = parsed.host.toLowerCase();
      const hostType: "github" | "gitlab" =
        hostLower === "github.com" ? "github" : "gitlab";
      return {
        name: r.name,
        path: r.path,
        remoteUrl,
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
        hostType,
      };
    },
    8,
  );
  return results.filter((x): x is LocalRemote => x !== null);
}

function resolveGithubAccount(
  owner: string,
  config: Config,
  available: string[],
): string | undefined {
  const mapped = config.github.ownerAccounts[owner.toLowerCase()];
  if (mapped) return mapped;
  if (config.github.defaultAccount) return config.github.defaultAccount;
  return available[0];
}

// ─── GitHub fetch ─────────────────────────────────────────────────────────────

function mapGitHubIssue(
  raw: any,
  host: string,
  owner: string,
  repo: string,
  localPath: string | null,
): IssueRow | null {
  if (!raw || typeof raw.number !== "number") return null;
  // Search API returns pull_request field for PRs — skip
  if (raw.pull_request) return null;
  const labels: string[] = Array.isArray(raw.labels)
    ? raw.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [];
  const state: "open" | "closed" = raw.state === "closed" ? "closed" : "open";
  const assignees: string[] = Array.isArray(raw.assignees)
    ? raw.assignees.map((a: any) => a?.login).filter(Boolean)
    : [];
  return {
    id: issueId(host, owner, repo, raw.number),
    host,
    hostType: "github",
    owner,
    repo,
    number: raw.number,
    title: String(raw.title ?? ""),
    state,
    htmlUrl: String(raw.html_url ?? `https://${host}/${owner}/${repo}/issues/${raw.number}`),
    labels,
    author: raw.user?.login ?? null,
    assignees,
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    comments: typeof raw.comments === "number" ? raw.comments : 0,
    milestone: raw.milestone?.title ?? null,
    priority: inferPriorityFromLabels(labels),
    localPath,
  };
}

async function ghFetchJson(url: string, token: string): Promise<{ ok: boolean; status: number; data: any }> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data };
}

async function fetchGitHubRepoIssues(
  remote: LocalRemote,
  token: string,
  state: IssueStateFilter,
): Promise<{ issues: IssueRow[]; error?: string }> {
  const stateParam = state === "all" ? "all" : state;
  const url =
    `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/issues` +
    `?state=${stateParam}&per_page=${PER_REPO_FETCH_CAP}&sort=updated&direction=desc`;
  const { ok, status, data } = await ghFetchJson(url, token);
  if (!ok) {
    return {
      issues: [],
      error: `GitHub ${status}: ${data?.message ?? "failed to list issues"}`,
    };
  }
  if (!Array.isArray(data)) return { issues: [] };
  const issues: IssueRow[] = [];
  for (const raw of data) {
    const row = mapGitHubIssue(raw, remote.host, remote.owner, remote.repo, remote.path);
    if (row) issues.push(row);
  }
  return { issues };
}

async function fetchGitHubMine(
  token: string,
  state: IssueStateFilter,
  localKeys: Map<string, LocalRemote>,
): Promise<{ issues: IssueRow[]; error?: string }> {
  const queries = buildGitHubAttentionQueries(state);
  const issues: IssueRow[] = [];
  const errors: string[] = [];

  for (const q of queries) {
    const url =
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
      `&sort=updated&order=desc&per_page=${MINE_SEARCH_PER_PAGE}`;
    const { ok, status, data } = await ghFetchJson(url, token);
    if (!ok) {
      errors.push(`${status}: ${data?.message ?? "search failed"}`);
      continue;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const raw of items) {
      // repository_url: https://api.github.com/repos/owner/repo
      const repoUrl: string = raw.repository_url ?? raw.html_url ?? "";
      const m =
        repoUrl.match(/repos\/([^/]+)\/([^/#?]+)/) ||
        String(raw.html_url ?? "").match(/github\.com\/([^/]+)\/([^/]+)\/issues/);
      if (!m) continue;
      const owner = m[1];
      const repo = m[2];
      const key = remoteKey(owner, repo);
      const local = localKeys.get(key);
      if (!local) continue; // universe = local clones only
      const row = mapGitHubIssue(raw, "github.com", owner, repo, local.path);
      if (row) issues.push(row);
    }
  }

  if (issues.length === 0 && errors.length === queries.length) {
    return { issues: [], error: `GitHub search ${errors[0]}` };
  }
  return { issues: dedupeIssues(issues) };
}

// ─── GitLab fetch ─────────────────────────────────────────────────────────────

function mapGitLabIssue(
  raw: any,
  host: string,
  owner: string,
  repo: string,
  localPath: string | null,
): IssueRow | null {
  if (!raw || typeof raw.iid !== "number") return null;
  const labels: string[] = Array.isArray(raw.labels)
    ? raw.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [];
  const state: "open" | "closed" = raw.state === "closed" ? "closed" : "open";
  const assignees: string[] = Array.isArray(raw.assignees)
    ? raw.assignees.map((a: any) => a?.username).filter(Boolean)
    : [];
  const webUrl = String(raw.web_url ?? `https://${host}/${owner}/${repo}/-/issues/${raw.iid}`);
  return {
    id: issueId(host, owner, repo, raw.iid),
    host,
    hostType: "gitlab",
    owner,
    repo,
    number: raw.iid,
    title: String(raw.title ?? ""),
    state,
    htmlUrl: webUrl,
    labels,
    author: raw.author?.username ?? null,
    assignees,
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    comments: typeof raw.user_notes_count === "number" ? raw.user_notes_count : 0,
    milestone: raw.milestone?.title ?? null,
    priority: inferPriorityFromLabels(labels),
    localPath,
  };
}

async function glFetchJson(
  url: string,
  token: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const resp = await fetch(url, {
    headers: {
      "PRIVATE-TOKEN": token,
      Accept: "application/json",
    },
  });
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data };
}

function glProjectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

async function fetchGitLabRepoIssues(
  remote: LocalRemote,
  token: string,
  state: IssueStateFilter,
): Promise<{ issues: IssueRow[]; error?: string }> {
  const stateParam = state === "all" ? "all" : state === "closed" ? "closed" : "opened";
  const url =
    `https://${remote.host}/api/v4/projects/${glProjectPath(remote.owner, remote.repo)}/issues` +
    `?state=${stateParam}&per_page=${PER_REPO_FETCH_CAP}&order_by=updated_at&sort=desc`;
  const { ok, status, data } = await glFetchJson(url, token);
  if (!ok) {
    return {
      issues: [],
      error: `GitLab ${status}: ${data?.message ?? data?.error ?? "failed to list issues"}`,
    };
  }
  if (!Array.isArray(data)) return { issues: [] };
  return {
    issues: data
      .map((raw) => mapGitLabIssue(raw, remote.host, remote.owner, remote.repo, remote.path))
      .filter((x): x is IssueRow => x !== null),
  };
}

/** Mine for GitLab: assigned + created, intersected with local projects. Mentions via todos when available. */
async function fetchGitLabMine(
  host: string,
  token: string,
  state: IssueStateFilter,
  localKeys: Map<string, LocalRemote>,
): Promise<{ issues: IssueRow[]; error?: string }> {
  const stateParam = state === "all" ? "all" : state === "closed" ? "closed" : "opened";
  const scopes = ["assigned_to_me", "created_by_me"] as const;
  const collected: IssueRow[] = [];
  const errors: string[] = [];

  for (const scope of scopes) {
    const url =
      `https://${host}/api/v4/issues?scope=${scope}&state=${stateParam}` +
      `&per_page=${MINE_SEARCH_PER_PAGE}&order_by=updated_at&sort=desc`;
    const { ok, status, data } = await glFetchJson(url, token);
    if (!ok) {
      errors.push(`${scope}: ${status}`);
      continue;
    }
    if (!Array.isArray(data)) continue;
    for (const raw of data) {
      const pathWithNamespace: string =
        raw.references?.full?.split("#")[0] ??
        raw.web_url?.match(/https?:\/\/[^/]+\/(.+?)\/-\/issues/)?.[1] ??
        "";
      // Prefer project path from web_url
      let owner = "";
      let repo = "";
      const web = String(raw.web_url ?? "");
      const wm = web.match(/https?:\/\/[^/]+\/(.+?)\/-\/issues\/\d+/);
      if (wm) {
        const parts = wm[1].split("/");
        repo = parts.pop() ?? "";
        owner = parts.join("/");
      } else if (pathWithNamespace.includes("/")) {
        const parts = pathWithNamespace.split("/");
        repo = parts.pop() ?? "";
        owner = parts.join("/");
      }
      if (!owner || !repo) continue;
      const key = remoteKey(owner, repo);
      const local = localKeys.get(key);
      if (!local) continue;
      const row = mapGitLabIssue(raw, host, owner, repo, local.path);
      if (row) collected.push(row);
    }
  }

  // Mentions / attention via pending issue todos
  try {
    const todoUrl = `https://${host}/api/v4/todos?type=Issue&state=pending&per_page=50`;
    const { ok, data } = await glFetchJson(todoUrl, token);
    if (ok && Array.isArray(data)) {
      for (const todo of data) {
        const target = todo.target;
        if (!target || typeof target.iid !== "number") continue;
        const web = String(todo.target_url ?? target.web_url ?? "");
        const wm = web.match(/https?:\/\/[^/]+\/(.+?)\/-\/issues\/\d+/);
        if (!wm) continue;
        const parts = wm[1].split("/");
        const repo = parts.pop() ?? "";
        const owner = parts.join("/");
        const key = remoteKey(owner, repo);
        const local = localKeys.get(key);
        if (!local) continue;
        if (state !== "all") {
          const st = target.state === "closed" ? "closed" : "opened";
          if (state === "open" && st !== "opened") continue;
          if (state === "closed" && st !== "closed") continue;
        }
        const row = mapGitLabIssue(target, host, owner, repo, local.path);
        if (row) collected.push(row);
      }
    }
  } catch {
    // todos optional
  }

  if (collected.length === 0 && errors.length === scopes.length) {
    return { issues: [], error: `GitLab ${host}: ${errors.join("; ")}` };
  }
  return { issues: collected };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

function cacheKey(mode: IssueMode, state: IssueStateFilter, repo?: string): string {
  return `${mode}::${state}::${repo ?? "*"}`;
}

async function loadRawIssues(
  config: Config,
  mode: IssueMode,
  state: IssueStateFilter,
  repoFilter?: string,
): Promise<{ issues: IssueRow[]; failures: IssueFailure[]; remotes: IssuesResult["remotes"] }> {
  const remotes = await discoverLocalRemotes(config.scanPaths, config.ignoredRepos);
  const remotesMeta = remotes.map((r) => ({
    name: r.name,
    path: r.path,
    host: r.host,
    owner: r.owner,
    repo: r.repo,
    hostType: r.hostType,
  }));

  const localKeys = new Map<string, LocalRemote>();
  for (const r of remotes) {
    localKeys.set(remoteKey(r.owner, r.repo), r);
  }

  const failures: IssueFailure[] = [];
  let issues: IssueRow[] = [];

  const githubRemotes = remotes.filter((r) => r.hostType === "github");
  const gitlabRemotes = remotes.filter((r) => r.hostType === "gitlab");

  // Optional single-repo restriction for mode=repo or filter
  const onlyKey = repoFilter?.trim().toLowerCase();
  const matchRemote = (r: LocalRemote) =>
    !onlyKey || remoteKey(r.owner, r.repo) === onlyKey || r.name.toLowerCase() === onlyKey;

  if (mode === "repo" && onlyKey) {
    const remote = remotes.find(matchRemote);
    if (!remote) {
      failures.push({
        host: "local",
        message: `Repository "${repoFilter}" not found among local clones with remotes`,
      });
      return { issues: [], failures, remotes: remotesMeta };
    }
    if (remote.hostType === "github") {
      const accounts = await getGhAccounts().catch(() => [] as string[]);
      const account = resolveGithubAccount(remote.owner, config, accounts);
      try {
        const token = await getGhToken(account);
        const res = await fetchGitHubRepoIssues(remote, token, state);
        if (res.error) {
          failures.push({ path: remote.path, remote: remote.remoteUrl, host: remote.host, message: res.error });
        }
        issues = res.issues;
      } catch (e: any) {
        failures.push({
          path: remote.path,
          remote: remote.remoteUrl,
          host: remote.host,
          message: e?.message ?? "GitHub auth failed",
        });
      }
    } else {
      const token = config.gitlab.tokens[remote.host];
      if (!token) {
        failures.push({
          path: remote.path,
          remote: remote.remoteUrl,
          host: remote.host,
          message: `No GitLab token configured for ${remote.host}`,
        });
      } else {
        const res = await fetchGitLabRepoIssues(remote, token, state);
        if (res.error) {
          failures.push({ path: remote.path, remote: remote.remoteUrl, host: remote.host, message: res.error });
        }
        issues = res.issues;
      }
    }
    return { issues: dedupeIssues(issues), failures, remotes: remotesMeta };
  }

  if (mode === "mine") {
    // GitHub: search per logged-in account, intersect local
    const accounts = await getGhAccounts().catch(() => [] as string[]);
    const accountsToQuery = accounts.length > 0
      ? accounts
      : config.github.defaultAccount
        ? [config.github.defaultAccount]
        : [];

    if (accountsToQuery.length === 0 && githubRemotes.length > 0) {
      failures.push({
        host: "github.com",
        message: "No gh accounts available for Mine mode",
      });
    }

    for (const account of accountsToQuery) {
      try {
        const token = await getGhToken(account);
        const res = await fetchGitHubMine(token, state, localKeys);
        if (res.error) {
          failures.push({ host: "github.com", message: `${account}: ${res.error}` });
        }
        issues.push(...res.issues);
      } catch (e: any) {
        failures.push({
          host: "github.com",
          message: `${account}: ${e?.message ?? "auth failed"}`,
        });
      }
    }

    // GitLab: per host with token
    const glHosts = new Set(gitlabRemotes.map((r) => r.host));
    for (const host of glHosts) {
      const token = config.gitlab.tokens[host];
      if (!token) {
        failures.push({ host, message: `No GitLab token for ${host}` });
        continue;
      }
      const res = await fetchGitLabMine(host, token, state, localKeys);
      if (res.error) failures.push({ host, message: res.error });
      issues.push(...res.issues);
    }
  } else {
    // mode === "all" (or repo without filter falls through)
    const targets = remotes.filter(matchRemote);

    const ghResults = await pMap(
      targets.filter((r) => r.hostType === "github"),
      async (remote) => {
        const accounts = await getGhAccounts().catch(() => [] as string[]);
        const account = resolveGithubAccount(remote.owner, config, accounts);
        try {
          const token = await getGhToken(account);
          return { remote, ...(await fetchGitHubRepoIssues(remote, token, state)) };
        } catch (e: any) {
          return {
            remote,
            issues: [] as IssueRow[],
            error: e?.message ?? "GitHub auth failed",
          };
        }
      },
      FETCH_CONCURRENCY,
    );

    for (const res of ghResults) {
      if (res.error) {
        failures.push({
          path: res.remote.path,
          remote: res.remote.remoteUrl,
          host: res.remote.host,
          message: res.error,
        });
      }
      issues.push(...res.issues);
    }

    const glResults = await pMap(
      targets.filter((r) => r.hostType === "gitlab"),
      async (remote) => {
        const token = config.gitlab.tokens[remote.host];
        if (!token) {
          return {
            remote,
            issues: [] as IssueRow[],
            error: `No GitLab token for ${remote.host}`,
          };
        }
        return { remote, ...(await fetchGitLabRepoIssues(remote, token, state)) };
      },
      FETCH_CONCURRENCY,
    );

    for (const res of glResults) {
      if (res.error) {
        failures.push({
          path: res.remote.path,
          remote: res.remote.remoteUrl,
          host: res.remote.host,
          message: res.error,
        });
      }
      issues.push(...res.issues);
    }
  }

  return { issues: dedupeIssues(issues), failures, remotes: remotesMeta };
}

export async function getIssues(config: Config, query: IssuesQuery): Promise<IssuesResult> {
  const mode = query.mode;
  const state = query.state;
  const page = Math.max(1, query.page || 1);
  const perPage = query.perPage || PAGE_DEFAULT;
  const key = cacheKey(mode, state, mode === "repo" ? query.repo : undefined);

  let bag = listCache.get(key);
  let cached = false;
  const now = Date.now();

  if (!query.force && bag && now - bag.storedAt < CACHE_TTL_MS) {
    cached = true;
  } else {
    const loaded = await loadRawIssues(
      config,
      mode,
      state,
      mode === "repo" ? query.repo : undefined,
    );
    bag = {
      issues: loaded.issues,
      failures: loaded.failures,
      remotes: loaded.remotes,
      storedAt: now,
    };
    listCache.set(key, bag);
    // Bound cache size
    if (listCache.size > 40) {
      const oldest = [...listCache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
      if (oldest) listCache.delete(oldest[0]);
    }
  }

  const filtered = sortByUpdatedDesc(
    filterIssues(bag!.issues, {
      host: query.host,
      label: query.label,
      author: query.author,
      assignee: query.assignee,
      updated: query.updated,
      // state already applied at fetch for mode lists; re-apply for safety when filtering closed/open
      state: query.state,
      repoKey: mode === "repo" ? undefined : query.repo,
    }),
  );

  // Hard-hide: apply unless intentional single-repo focus (This repo / repo dropdown).
  const hidden = config.inbox?.hiddenRepos ?? [];
  const focusRepo = query.repo?.trim() || (mode === "repo" ? query.repo : undefined);
  const visible = excludeHiddenRows(filtered, hidden, { focusRepo });

  const { pageItems, hasMore, totalMatched } = paginateIssues(visible, page, perPage);

  return {
    issues: pageItems,
    page,
    perPage,
    hasMore,
    totalMatched,
    generatedAt: new Date(bag!.storedAt).toISOString(),
    cached,
    failures: bag!.failures,
    remotes: bag!.remotes,
    hiddenCount: hidden.length,
  };
}
