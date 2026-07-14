/**
 * lib/work.ts
 *
 * Attention queue: issues + PRs on local remotes.
 * Sections: review → assign → author → mention → other.
 */

import { getGhAccounts, getGhToken } from "./gh";
import {
  discoverLocalRemotes,
  remoteKey,
  inferPriorityFromLabels,
  issueId,
  type IssueFailure,
  type IssueStateFilter,
  type LocalRemote,
} from "./issues";
import { pMap } from "./gitStatus";
import type { Config } from "./config";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkAttention = "review" | "assign" | "author" | "mention" | "other";
export type WorkKind = "issue" | "pr";

export interface WorkRow {
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
  priority: "high" | "medium" | "low" | null;
  localPath: string | null;
  kind: WorkKind;
  attention: WorkAttention;
}

export interface WorkQuery {
  state?: IssueStateFilter;
  force?: boolean;
}

export interface WorkResult {
  items: WorkRow[];
  sections: Array<{ attention: WorkAttention; label: string; items: WorkRow[] }>;
  generatedAt: string;
  cached: boolean;
  failures: IssueFailure[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 90_000;
const SEARCH_PER_PAGE = 100;
const SECTION_ORDER: WorkAttention[] = ["review", "assign", "author", "mention", "other"];
const SECTION_LABELS: Record<WorkAttention, string> = {
  review: "Reviews",
  assign: "Assigned",
  author: "Author",
  mention: "Mentioned",
  other: "Other",
};

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheBag {
  items: WorkRow[];
  failures: IssueFailure[];
  storedAt: number;
}

let cache: CacheBag | null = null;

export function clearWorkCache(): void {
  cache = null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function buildGitHubWorkQueries(state: IssueStateFilter): string[] {
  const statePart =
    state === "open" ? "is:open" : state === "closed" ? "is:closed" : "";
  const issueBase = ["is:issue", statePart].filter(Boolean).join(" ");
  const prBase = ["is:pr", statePart].filter(Boolean).join(" ");
  return [
    `${issueBase} assignee:@me`,
    `${issueBase} author:@me`,
    `${issueBase} mentions:@me`,
    `${prBase} assignee:@me`,
    `${prBase} author:@me`,
    `${prBase} mentions:@me`,
    `${prBase} review-requested:@me`,
  ];
}

export function mapAttention(source: string): WorkAttention {
  switch (source) {
    case "review-requested":
      return "review";
    case "assignee":
      return "assign";
    case "author":
      return "author";
    case "mentions":
      return "mention";
    default:
      return "other";
  }
}

function attentionRank(a: WorkAttention): number {
  const i = SECTION_ORDER.indexOf(a);
  return i === -1 ? 99 : i;
}

export type WorkSection = {
  attention: WorkAttention;
  label: string;
  items: WorkRow[];
};

export function sortWorkSections(rows: WorkRow[]): WorkRow[];
export function sortWorkSections(rows: WorkRow[], opts: { asSections: true }): WorkSection[];
export function sortWorkSections(
  rows: WorkRow[],
  opts?: { asSections?: boolean },
): WorkRow[] | WorkSection[] {
  const sorted = [...rows].sort((a, b) => {
    const ra = attentionRank(a.attention);
    const rb = attentionRank(b.attention);
    if (ra !== rb) return ra - rb;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });
  if (!opts?.asSections) return sorted;

  const map = new Map<WorkAttention, WorkRow[]>();
  for (const r of sorted) {
    const list = map.get(r.attention) ?? [];
    list.push(r);
    map.set(r.attention, list);
  }
  const sections: WorkSection[] = [];
  for (const attention of SECTION_ORDER) {
    const items = map.get(attention);
    if (!items?.length) continue;
    sections.push({ attention, label: SECTION_LABELS[attention], items });
  }
  return sections;
}

function dedupeWork(rows: WorkRow[]): WorkRow[] {
  // Prefer stronger attention when same id appears from multiple queries
  const rank = (a: WorkAttention) => attentionRank(a);
  const map = new Map<string, WorkRow>();
  for (const r of rows) {
    const prev = map.get(r.id);
    if (!prev || rank(r.attention) < rank(prev.attention)) {
      map.set(r.id, r);
    }
  }
  return [...map.values()];
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function ghFetchJson(
  url: string,
  token: string,
): Promise<{ ok: boolean; status: number; data: any }> {
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

async function glFetchJson(
  url: string,
  token: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const resp = await fetch(url, {
    headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
  });
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data };
}

function attentionFromQuery(q: string): WorkAttention {
  if (q.includes("review-requested:@me")) return "review";
  if (q.includes("assignee:@me")) return "assign";
  if (q.includes("author:@me")) return "author";
  if (q.includes("mentions:@me")) return "mention";
  return "other";
}

function mapGhWorkItem(
  raw: any,
  owner: string,
  repo: string,
  localPath: string | null,
  attention: WorkAttention,
): WorkRow | null {
  if (!raw || typeof raw.number !== "number") return null;
  const isPr = !!raw.pull_request || String(raw.html_url ?? "").includes("/pull/");
  const labels: string[] = Array.isArray(raw.labels)
    ? raw.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [];
  const assignees: string[] = Array.isArray(raw.assignees)
    ? raw.assignees.map((a: any) => a?.login).filter(Boolean)
    : [];
  return {
    id: issueId("github.com", owner, repo, raw.number),
    host: "github.com",
    hostType: "github",
    owner,
    repo,
    number: raw.number,
    title: String(raw.title ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    htmlUrl: String(
      raw.html_url ??
        `https://github.com/${owner}/${repo}/${isPr ? "pull" : "issues"}/${raw.number}`,
    ),
    labels,
    author: raw.user?.login ?? null,
    assignees,
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    comments: typeof raw.comments === "number" ? raw.comments : 0,
    milestone: raw.milestone?.title ?? null,
    priority: inferPriorityFromLabels(labels),
    localPath,
    kind: isPr ? "pr" : "issue",
    attention,
  };
}

async function fetchGitHubWork(
  token: string,
  state: IssueStateFilter,
  localKeys: Map<string, LocalRemote>,
): Promise<{ items: WorkRow[]; error?: string }> {
  const queries = buildGitHubWorkQueries(state);
  const items: WorkRow[] = [];
  const errors: string[] = [];

  for (const q of queries) {
    const url =
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
      `&sort=updated&order=desc&per_page=${SEARCH_PER_PAGE}`;
    const { ok, status, data } = await ghFetchJson(url, token);
    if (!ok) {
      errors.push(`${status}: ${data?.message ?? "search failed"}`);
      continue;
    }
    const attention = attentionFromQuery(q);
    const list = Array.isArray(data?.items) ? data.items : [];
    for (const raw of list) {
      const repoUrl: string = raw.repository_url ?? raw.html_url ?? "";
      const m =
        repoUrl.match(/repos\/([^/]+)\/([^/#?]+)/) ||
        String(raw.html_url ?? "").match(/github\.com\/([^/]+)\/([^/]+)\//);
      if (!m) continue;
      const owner = m[1];
      const repo = m[2];
      const local = localKeys.get(remoteKey(owner, repo));
      if (!local) continue;
      const row = mapGhWorkItem(raw, owner, repo, local.path, attention);
      if (row) items.push(row);
    }
  }

  if (items.length === 0 && errors.length === queries.length) {
    return { items: [], error: `GitHub search ${errors[0]}` };
  }
  return { items: dedupeWork(items) };
}

async function fetchGitLabWork(
  host: string,
  token: string,
  state: IssueStateFilter,
  localKeys: Map<string, LocalRemote>,
): Promise<{ items: WorkRow[]; error?: string }> {
  const stateParam = state === "all" ? "all" : state === "closed" ? "closed" : "opened";
  const items: WorkRow[] = [];
  const errors: string[] = [];

  // Issues: assigned + created
  for (const scope of ["assigned_to_me", "created_by_me"] as const) {
    const attention: WorkAttention = scope === "assigned_to_me" ? "assign" : "author";
    const url =
      `https://${host}/api/v4/issues?scope=${scope}&state=${stateParam}` +
      `&per_page=50&order_by=updated_at&sort=desc`;
    const { ok, status, data } = await glFetchJson(url, token);
    if (!ok) {
      errors.push(`issues ${scope}: ${status}`);
      continue;
    }
    if (!Array.isArray(data)) continue;
    for (const raw of data) {
      const web = String(raw.web_url ?? "");
      const wm = web.match(/https?:\/\/[^/]+\/(.+?)\/-\/issues\/\d+/);
      if (!wm) continue;
      const parts = wm[1].split("/");
      const repo = parts.pop() ?? "";
      const owner = parts.join("/");
      const local = localKeys.get(remoteKey(owner, repo));
      if (!local) continue;
      const labels: string[] = Array.isArray(raw.labels)
        ? raw.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
        : [];
      items.push({
        id: issueId(host, owner, repo, raw.iid),
        host,
        hostType: "gitlab",
        owner,
        repo,
        number: raw.iid,
        title: String(raw.title ?? ""),
        state: raw.state === "closed" ? "closed" : "open",
        htmlUrl: web,
        labels,
        author: raw.author?.username ?? null,
        assignees: Array.isArray(raw.assignees)
          ? raw.assignees.map((a: any) => a?.username).filter(Boolean)
          : [],
        createdAt: String(raw.created_at ?? ""),
        updatedAt: String(raw.updated_at ?? ""),
        comments: typeof raw.user_notes_count === "number" ? raw.user_notes_count : 0,
        milestone: raw.milestone?.title ?? null,
        priority: inferPriorityFromLabels(labels),
        localPath: local.path,
        kind: "issue",
        attention,
      });
    }
  }

  // MRs: assigned, created, review requested
  for (const scope of ["assigned_to_me", "created_by_me"] as const) {
    const attention: WorkAttention = scope === "assigned_to_me" ? "assign" : "author";
    const url =
      `https://${host}/api/v4/merge_requests?scope=${scope}&state=${stateParam === "opened" ? "opened" : stateParam}` +
      `&per_page=50&order_by=updated_at&sort=desc`;
    const { ok, status, data } = await glFetchJson(url, token);
    if (!ok) {
      errors.push(`mr ${scope}: ${status}`);
      continue;
    }
    if (!Array.isArray(data)) continue;
    for (const raw of data) {
      const web = String(raw.web_url ?? "");
      const wm = web.match(/https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/);
      if (!wm) continue;
      const parts = wm[1].split("/");
      const repo = parts.pop() ?? "";
      const owner = parts.join("/");
      const local = localKeys.get(remoteKey(owner, repo));
      if (!local) continue;
      const labels: string[] = Array.isArray(raw.labels)
        ? raw.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
        : [];
      items.push({
        id: issueId(host, owner, repo, raw.iid),
        host,
        hostType: "gitlab",
        owner,
        repo,
        number: raw.iid,
        title: String(raw.title ?? ""),
        state: raw.state === "closed" || raw.state === "merged" ? "closed" : "open",
        htmlUrl: web,
        labels,
        author: raw.author?.username ?? null,
        assignees: Array.isArray(raw.assignees)
          ? raw.assignees.map((a: any) => a?.username).filter(Boolean)
          : [],
        createdAt: String(raw.created_at ?? ""),
        updatedAt: String(raw.updated_at ?? ""),
        comments: typeof raw.user_notes_count === "number" ? raw.user_notes_count : 0,
        milestone: raw.milestone?.title ?? null,
        priority: inferPriorityFromLabels(labels),
        localPath: local.path,
        kind: "pr",
        attention,
      });
    }
  }

  // Reviewer MRs
  {
    const url =
      `https://${host}/api/v4/merge_requests?reviewer_username=me&state=opened` +
      `&per_page=50&order_by=updated_at&sort=desc`;
    // GitLab uses reviewer_id better — try scope alternative
    const alt =
      `https://${host}/api/v4/merge_requests?scope=reviews_for_me&state=opened` +
      `&per_page=50&order_by=updated_at&sort=desc`;
    for (const tryUrl of [alt, url]) {
      const { ok, data } = await glFetchJson(tryUrl, token);
      if (!ok || !Array.isArray(data)) continue;
      for (const raw of data) {
        const web = String(raw.web_url ?? "");
        const wm = web.match(/https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/);
        if (!wm) continue;
        const parts = wm[1].split("/");
        const repo = parts.pop() ?? "";
        const owner = parts.join("/");
        const local = localKeys.get(remoteKey(owner, repo));
        if (!local) continue;
        items.push({
          id: issueId(host, owner, repo, raw.iid),
          host,
          hostType: "gitlab",
          owner,
          repo,
          number: raw.iid,
          title: String(raw.title ?? ""),
          state: "open",
          htmlUrl: web,
          labels: [],
          author: raw.author?.username ?? null,
          assignees: [],
          createdAt: String(raw.created_at ?? ""),
          updatedAt: String(raw.updated_at ?? ""),
          comments: 0,
          milestone: null,
          priority: null,
          localPath: local.path,
          kind: "pr",
          attention: "review",
        });
      }
      break;
    }
  }

  return { items: dedupeWork(items), error: errors.length ? errors.join("; ") : undefined };
}

async function loadWork(
  config: Config,
  state: IssueStateFilter,
): Promise<{ items: WorkRow[]; failures: IssueFailure[] }> {
  const remotes = await discoverLocalRemotes(config.scanPaths, config.ignoredRepos);
  const localKeys = new Map<string, LocalRemote>();
  for (const r of remotes) localKeys.set(remoteKey(r.owner, r.repo), r);

  const failures: IssueFailure[] = [];
  const items: WorkRow[] = [];

  const accounts = await getGhAccounts().catch(() => [] as string[]);
  const accountsToQuery =
    accounts.length > 0
      ? accounts
      : config.github.defaultAccount
        ? [config.github.defaultAccount]
        : [];

  for (const account of accountsToQuery) {
    try {
      const token = await getGhToken(account);
      const res = await fetchGitHubWork(token, state, localKeys);
      if (res.error) failures.push({ host: "github.com", message: `${account}: ${res.error}` });
      items.push(...res.items);
    } catch (e: any) {
      failures.push({ host: "github.com", message: `${account}: ${e?.message ?? "auth failed"}` });
    }
  }

  const glHosts = new Set(remotes.filter((r) => r.hostType === "gitlab").map((r) => r.host));
  for (const host of glHosts) {
    const token = config.gitlab.tokens[host];
    if (!token) {
      failures.push({ host, message: `No GitLab token for ${host}` });
      continue;
    }
    const res = await fetchGitLabWork(host, token, state, localKeys);
    if (res.error) failures.push({ host, message: res.error });
    items.push(...res.items);
  }

  return { items: dedupeWork(items), failures };
}

export async function getWork(config: Config, query: WorkQuery = {}): Promise<WorkResult> {
  const state: IssueStateFilter = query.state ?? "open";
  const now = Date.now();
  let bag = cache;
  let cached = false;

  if (!query.force && bag && now - bag.storedAt < CACHE_TTL_MS) {
    cached = true;
  } else {
    const loaded = await loadWork(config, state);
    bag = { items: loaded.items, failures: loaded.failures, storedAt: now };
    cache = bag;
  }

  const sorted = sortWorkSections(bag!.items);
  const sections = sortWorkSections(bag!.items, { asSections: true });

  return {
    items: sorted,
    sections,
    generatedAt: new Date(bag!.storedAt).toISOString(),
    cached,
    failures: bag!.failures,
  };
}
