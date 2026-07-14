/**
 * lib/notifications.ts
 *
 * GitHub notifications + GitLab todos → unified Inbox Notifications mode.
 * Soft triage: done / read / mute (mute GH-only).
 */

import { getGhAccounts, getGhToken } from "./gh";
import { discoverLocalRemotes, remoteKey, type LocalRemote } from "./issues";
import type { Config } from "./config";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotifReason =
  | "review"
  | "assign"
  | "mention"
  | "author"
  | "ci"
  | "bot"
  | "watching"
  | "subscribed"
  | "other";

export interface NotificationRow {
  id: string;
  host: string;
  hostType: "github" | "gitlab";
  account: string | null;
  reason: NotifReason;
  unread: boolean;
  done: boolean;
  title: string;
  repo: string | null;
  subjectType: string;
  htmlUrl: string;
  updatedAt: string;
  threadId: string;
  muteSupported: boolean;
  isLocalRemote: boolean;
}

export interface NotificationFailure {
  host: string;
  account?: string;
  message: string;
}

export interface NotificationsQuery {
  localOnly: boolean;
  includeCi: boolean;
  includeBots: boolean;
  includeWatching: boolean;
  /** gh login filter; omit or "all" = all accounts */
  account?: string;
  force?: boolean;
}

export interface NotificationsResult {
  notifications: NotificationRow[];
  groups: Array<{ reason: NotifReason; label: string; items: NotificationRow[] }>;
  undonedCount: number;
  generatedAt: string;
  cached: boolean;
  failures: NotificationFailure[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 90_000;
const GH_PAGES_CAP = 3;
const GH_PER_PAGE = 50;
const REASON_ORDER: NotifReason[] = [
  "review",
  "assign",
  "mention",
  "author",
  "ci",
  "bot",
  "watching",
  "subscribed",
  "other",
];

const REASON_LABELS: Record<NotifReason, string> = {
  review: "Review",
  assign: "Assign",
  mention: "Mention",
  author: "Author",
  ci: "CI",
  bot: "Bot",
  watching: "Watching",
  subscribed: "Subscribed",
  other: "Other",
};

const BOT_TITLE_RE = /dependabot|renovate\[bot\]|\[bot\]|github-actions/i;

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheBag {
  rows: NotificationRow[];
  failures: NotificationFailure[];
  storedAt: number;
}

let cache: CacheBag | null = null;

export function clearNotificationsCache(): void {
  cache = null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function mapGhReason(reason: string | null | undefined): NotifReason {
  const r = (reason ?? "").toLowerCase();
  switch (r) {
    case "review_requested":
    case "team_mention":
      return r === "review_requested" ? "review" : "mention";
    case "assign":
      return "assign";
    case "mention":
    case "comment":
      return "mention";
    case "author":
      return "author";
    case "ci_activity":
    case "check_suite":
      return "ci";
    case "subscribed":
      return "subscribed";
    case "manual":
    case "state_change":
    case "security_alert":
      return "other";
    default:
      if (r.includes("review")) return "review";
      if (r.includes("ci") || r.includes("check")) return "ci";
      return "other";
  }
}

export function isCiOrBot(row: NotificationRow): boolean {
  if (row.reason === "ci" || row.reason === "bot") return true;
  if (BOT_TITLE_RE.test(row.title)) return true;
  return false;
}

export function isParticipatingReason(reason: NotifReason): boolean {
  return reason === "review" || reason === "assign" || reason === "mention" || reason === "author";
}

export function filterNotificationDefaults(
  rows: NotificationRow[],
  opts: {
    localOnly: boolean;
    includeCi: boolean;
    includeBots: boolean;
    includeWatching: boolean;
    account?: string;
  },
): NotificationRow[] {
  return rows.filter((r) => {
    if (r.done) return false;
    if (opts.localOnly && !r.isLocalRemote) return false;
    if (opts.account && opts.account !== "all" && r.account && r.account !== opts.account) {
      return false;
    }
    const botty = isCiOrBot(r) || r.reason === "bot";
    if (botty && !opts.includeBots && r.reason !== "ci") return false;
    if (r.reason === "ci" && !opts.includeCi) return false;
    if ((r.reason === "watching" || r.reason === "subscribed") && !opts.includeWatching) {
      return false;
    }
    // Participating-first: non-participating (other) stays unless watching chip covers subscribed
    if (!isParticipatingReason(r.reason) && r.reason !== "ci" && r.reason !== "bot") {
      if (r.reason === "watching" || r.reason === "subscribed") {
        return opts.includeWatching;
      }
      // "other" — include when participating filters allow (treat as borderline attention)
      return true;
    }
    if (botty && r.reason === "ci") return opts.includeCi;
    if (botty && !opts.includeBots) return false;
    return true;
  });
}

export function groupByReason(
  rows: NotificationRow[],
): Array<{ reason: NotifReason; label: string; items: NotificationRow[] }> {
  const map = new Map<NotifReason, NotificationRow[]>();
  for (const r of rows) {
    const list = map.get(r.reason) ?? [];
    list.push(r);
    map.set(r.reason, list);
  }
  const groups: Array<{ reason: NotifReason; label: string; items: NotificationRow[] }> = [];
  for (const reason of REASON_ORDER) {
    const items = map.get(reason);
    if (!items?.length) continue;
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    groups.push({ reason, label: REASON_LABELS[reason], items });
  }
  return groups;
}

export function countUndone(rows: NotificationRow[]): number {
  return rows.filter((r) => !r.done).length;
}

export function dedupeNotificationRows(rows: NotificationRow[]): NotificationRow[] {
  const seen = new Set<string>();
  const out: NotificationRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function ghFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any }> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  let data: any = null;
  const text = await resp.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: resp.ok, status: resp.status, data };
}

async function glFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any }> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": token,
      Accept: "application/json",
      ...(init?.headers ?? {}),
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

function parseRepoFromGh(raw: any): string | null {
  const full = raw?.repository?.full_name;
  if (typeof full === "string" && full.includes("/")) return full;
  const url = String(raw?.subject?.url ?? raw?.repository?.html_url ?? "");
  const m = url.match(/repos\/([^/]+)\/([^/?#]+)/) || url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

function subjectHtmlUrl(raw: any, repo: string | null): string {
  const latest = raw?.subject?.latest_comment_url;
  // Prefer html via subject url rewrite
  const apiUrl = String(raw?.subject?.url ?? "");
  if (apiUrl.includes("/pulls/")) {
    const m = apiUrl.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
    if (m) return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
  }
  if (apiUrl.includes("/issues/")) {
    const m = apiUrl.match(/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (m) return `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`;
  }
  if (repo) return `https://github.com/${repo}`;
  return raw?.repository?.html_url ?? "https://github.com/notifications";
}

function mapGhNotification(
  raw: any,
  account: string,
  localKeys: Map<string, LocalRemote>,
): NotificationRow | null {
  if (!raw?.id) return null;
  const threadId = String(raw.id);
  const repo = parseRepoFromGh(raw);
  const key = repo ? remoteKey(repo.split("/")[0], repo.split("/").slice(1).join("/")) : "";
  const isLocal = key ? localKeys.has(key) : false;
  let reason = mapGhReason(raw.reason);
  const title = String(raw.subject?.title ?? "");
  if (BOT_TITLE_RE.test(title) && reason !== "ci") reason = "bot";
  return {
    id: `gh:${account}:${threadId}`,
    host: "github.com",
    hostType: "github",
    account,
    reason,
    unread: raw.unread === true,
    done: false, // list endpoint returns inbox items; done are excluded when all=false path
    title,
    repo,
    subjectType: String(raw.subject?.type ?? "Unknown"),
    htmlUrl: subjectHtmlUrl(raw, repo),
    updatedAt: String(raw.updated_at ?? raw.last_read_at ?? ""),
    threadId,
    muteSupported: true,
    isLocalRemote: isLocal,
  };
}

function mapGlTodo(
  raw: any,
  host: string,
  localKeys: Map<string, LocalRemote>,
): NotificationRow | null {
  if (!raw?.id) return null;
  const target = raw.target ?? {};
  const web = String(raw.target_url ?? target.web_url ?? "");
  let owner = "";
  let repoName = "";
  const wm =
    web.match(/https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|merge_requests)\/\d+/) ||
    web.match(/https?:\/\/[^/]+\/(.+?)\/-\//);
  if (wm) {
    const parts = wm[1].split("/");
    repoName = parts.pop() ?? "";
    owner = parts.join("/");
  }
  const repo = owner && repoName ? `${owner}/${repoName}` : null;
  const key = owner && repoName ? remoteKey(owner, repoName) : "";
  const action = String(raw.action_name ?? raw.body ?? "").toLowerCase();
  let reason: NotifReason = "other";
  if (action.includes("approval") || action.includes("review")) reason = "review";
  else if (action.includes("assigned")) reason = "assign";
  else if (action.includes("mentioned") || action.includes("directly_addressed")) reason = "mention";
  else if (action.includes("build") || action.includes("pipeline")) reason = "ci";
  else if (action.includes("approval_required")) reason = "review";

  return {
    id: `gl:${host}:${raw.id}`,
    host,
    hostType: "gitlab",
    account: null,
    reason,
    unread: raw.state === "pending",
    done: raw.state === "done",
    title: String(target.title ?? raw.body ?? "Todo"),
    repo,
    subjectType: String(raw.target_type ?? "Issue"),
    htmlUrl: web || `https://${host}`,
    updatedAt: String(raw.updated_at ?? raw.created_at ?? ""),
    threadId: String(raw.id),
    muteSupported: false,
    isLocalRemote: key ? localKeys.has(key) : false,
  };
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchGhAccountNotifications(
  account: string,
  token: string,
  localKeys: Map<string, LocalRemote>,
): Promise<{ rows: NotificationRow[]; error?: string }> {
  const rows: NotificationRow[] = [];
  for (let page = 1; page <= GH_PAGES_CAP; page++) {
    // all=false → participating-ish inbox; we still fetch broadly and filter client-side
    const url =
      `https://api.github.com/notifications?all=true&participating=false` +
      `&per_page=${GH_PER_PAGE}&page=${page}`;
    const { ok, status, data } = await ghFetch(url, token);
    if (!ok) {
      if (status === 403 || status === 401) {
        return {
          rows,
          error:
            status === 403
              ? `notifications scope missing for ${account} — run: gh auth refresh -h github.com -s notifications`
              : `auth failed for ${account}`,
        };
      }
      return { rows, error: `GitHub ${status}: ${data?.message ?? "notifications failed"}` };
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const raw of data) {
      const row = mapGhNotification(raw, account, localKeys);
      if (row) rows.push(row);
    }
    if (data.length < GH_PER_PAGE) break;
  }
  return { rows };
}

async function fetchGlTodos(
  host: string,
  token: string,
  localKeys: Map<string, LocalRemote>,
): Promise<{ rows: NotificationRow[]; error?: string }> {
  const url = `https://${host}/api/v4/todos?state=pending&per_page=100`;
  const { ok, status, data } = await glFetch(url, token);
  if (!ok) {
    return { rows: [], error: `GitLab ${host} ${status}: ${data?.message ?? "todos failed"}` };
  }
  if (!Array.isArray(data)) return { rows: [] };
  const rows: NotificationRow[] = [];
  for (const raw of data) {
    const row = mapGlTodo(raw, host, localKeys);
    if (row) rows.push(row);
  }
  return { rows };
}

async function loadAllNotifications(
  config: Config,
): Promise<{ rows: NotificationRow[]; failures: NotificationFailure[] }> {
  const remotes = await discoverLocalRemotes(config.scanPaths, config.ignoredRepos);
  const localKeys = new Map<string, LocalRemote>();
  for (const r of remotes) localKeys.set(remoteKey(r.owner, r.repo), r);

  const failures: NotificationFailure[] = [];
  const rows: NotificationRow[] = [];

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
      const res = await fetchGhAccountNotifications(account, token, localKeys);
      if (res.error) failures.push({ host: "github.com", account, message: res.error });
      rows.push(...res.rows);
    } catch (e: any) {
      failures.push({
        host: "github.com",
        account,
        message: e?.message ?? "auth failed",
      });
    }
  }

  const glHosts = new Set(
    remotes.filter((r) => r.hostType === "gitlab").map((r) => r.host),
  );
  // Also any configured tokens
  for (const host of Object.keys(config.gitlab.tokens ?? {})) glHosts.add(host);

  for (const host of glHosts) {
    const token = config.gitlab.tokens[host];
    if (!token) {
      failures.push({ host, message: `No GitLab token for ${host}` });
      continue;
    }
    const res = await fetchGlTodos(host, token, localKeys);
    if (res.error) failures.push({ host, message: res.error });
    rows.push(...res.rows);
  }

  return { rows: dedupeNotificationRows(rows), failures };
}

export async function getNotifications(
  config: Config,
  query: NotificationsQuery,
): Promise<NotificationsResult> {
  const now = Date.now();
  let bag = cache;
  let cached = false;

  if (!query.force && bag && now - bag.storedAt < CACHE_TTL_MS) {
    cached = true;
  } else {
    const loaded = await loadAllNotifications(config);
    bag = { rows: loaded.rows, failures: loaded.failures, storedAt: now };
    cache = bag;
  }

  const filtered = filterNotificationDefaults(bag!.rows, {
    localOnly: query.localOnly,
    includeCi: query.includeCi,
    includeBots: query.includeBots,
    includeWatching: query.includeWatching,
    account: query.account,
  });

  // Account filter already applied; dimmed read stays in list
  const groups = groupByReason(filtered);

  return {
    notifications: filtered,
    groups,
    undonedCount: countUndone(filtered),
    generatedAt: new Date(bag!.storedAt).toISOString(),
    cached,
    failures: bag!.failures,
  };
}

// ─── Soft triage ──────────────────────────────────────────────────────────────

export interface TriageInput {
  threadId: string;
  hostType: "github" | "gitlab";
  host: string;
  account?: string;
}

async function resolveGhTokenForTriage(account: string | undefined, config: Config): Promise<string> {
  if (account) return getGhToken(account);
  if (config.github.defaultAccount) return getGhToken(config.github.defaultAccount);
  const accounts = await getGhAccounts();
  if (accounts[0]) return getGhToken(accounts[0]);
  throw new Error("No GitHub account available");
}

export async function markNotificationDone(
  config: Config,
  input: TriageInput,
): Promise<{ ok: boolean; message?: string }> {
  if (input.hostType === "github") {
    const token = await resolveGhTokenForTriage(input.account, config);
    // Mark thread as done
    const { ok, status, data } = await ghFetch(
      `https://api.github.com/notifications/threads/${encodeURIComponent(input.threadId)}`,
      token,
      { method: "DELETE" },
    );
    if (!ok) {
      return { ok: false, message: `GitHub ${status}: ${data?.message ?? "mark done failed"}` };
    }
    clearNotificationsCache();
    return { ok: true };
  }
  const token = config.gitlab.tokens[input.host];
  if (!token) return { ok: false, message: `No GitLab token for ${input.host}` };
  const { ok, status, data } = await glFetch(
    `https://${input.host}/api/v4/todos/${encodeURIComponent(input.threadId)}/mark_as_done`,
    token,
    { method: "POST" },
  );
  if (!ok) {
    return { ok: false, message: `GitLab ${status}: ${data?.message ?? "mark done failed"}` };
  }
  clearNotificationsCache();
  return { ok: true };
}

export async function markNotificationRead(
  config: Config,
  input: TriageInput & { unread?: boolean },
): Promise<{ ok: boolean; message?: string }> {
  if (input.hostType === "gitlab") {
    // GitLab todos have no unread toggle separate from done — no-op success
    return { ok: true, message: "GitLab todos do not support mark-read; use done" };
  }
  const token = await resolveGhTokenForTriage(input.account, config);
  if (input.unread) {
    // GitHub has no direct "mark unread" on thread in all API versions — soft-fail
    return { ok: false, message: "Mark unread is not supported by GitHub API for threads" };
  }
  const { ok, status, data } = await ghFetch(
    `https://api.github.com/notifications/threads/${encodeURIComponent(input.threadId)}`,
    token,
    { method: "PATCH" },
  );
  if (!ok) {
    return { ok: false, message: `GitHub ${status}: ${data?.message ?? "mark read failed"}` };
  }
  clearNotificationsCache();
  return { ok: true };
}

export async function muteNotification(
  config: Config,
  input: TriageInput,
): Promise<{ ok: boolean; message?: string }> {
  if (input.hostType === "gitlab") {
    return { ok: false, message: "Mute is not supported for GitLab todos" };
  }
  const token = await resolveGhTokenForTriage(input.account, config);
  const { ok, status, data } = await ghFetch(
    `https://api.github.com/notifications/threads/${encodeURIComponent(input.threadId)}/subscription`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: true }),
    },
  );
  if (!ok) {
    return { ok: false, message: `GitHub ${status}: ${data?.message ?? "mute failed"}` };
  }
  clearNotificationsCache();
  return { ok: true };
}
