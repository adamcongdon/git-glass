/**
 * lib/activity.ts
 *
 * Multi-account contribution heatmap + activity breakdown for the Activity tab.
 * Host-side graphs (GitHub GraphQL + GitLab Events API), unioned by day.
 */

import { getGhAccounts, getGhToken } from "./gh";
import type { Config } from "./config";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActivityWindow = "7d" | "30d" | "90d" | "1y";

export interface ActivityAccount {
  id: string;
  host: "github" | "gitlab";
  login: string;
  gitlabHost?: string;
  label: string;
  error?: string;
}

export interface DayCount {
  date: string; // YYYY-MM-DD
  count: number;
  byAccount: Record<string, number>;
}

export interface ActivityTotals {
  commits: number;
  pullRequests: number;
  issues: number;
  reviews: number;
  total: number;
}

export interface DayEvent {
  id: string;
  type: "commit" | "pull_request" | "issue" | "review" | "other";
  title: string;
  url: string | null;
  accountId: string;
  createdAt: string;
  repo?: string;
}

export interface ActivityDashboard {
  window: ActivityWindow;
  generatedAt: string;
  accounts: ActivityAccount[];
  days: DayCount[];
  totals: ActivityTotals;
  from: string;
  to: string;
  cacheTtlSec: number;
}

export interface DayDetail {
  date: string;
  events: DayEvent[];
  generatedAt: string;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const dashboardCache = new Map<string, CacheEntry<ActivityDashboard>>();
const dayCache = new Map<string, CacheEntry<DayDetail>>();
export const ACTIVITY_CACHE_TTL_MS = 15 * 60 * 1000;

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, expiresAt: Date.now() + ACTIVITY_CACHE_TTL_MS });
}

export function clearActivityCache(): void {
  dashboardCache.clear();
  dayCache.clear();
}

// ─── Window helpers ───────────────────────────────────────────────────────────

const WINDOW_DAYS: Record<ActivityWindow, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export function parseActivityWindow(input: string | undefined): ActivityWindow {
  if (input === "7d" || input === "30d" || input === "90d" || input === "1y") return input;
  if (input === undefined || input === "") return "1y";
  throw new Error(`Invalid window "${input}". Must be one of: 7d, 30d, 90d, 1y.`);
}

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeForWindow(window: ActivityWindow): { from: string; to: string; fromDate: Date; toDate: Date } {
  const toDate = new Date();
  const to = isoDateUTC(toDate);
  // Heatmap is always ~52 weeks; window chips filter totals/breakdown.
  // For GraphQL we request full year; client filters totals by window.
  const days = WINDOW_DAYS[window];
  const fromDate = new Date(toDate.getTime() - (days - 1) * 86400000);
  return { from: isoDateUTC(fromDate), to, fromDate, toDate };
}

/** Last 53 weeks of calendar days ending today (GitHub-style grid). */
function heatmapRange(): { from: string; to: string } {
  const toDate = new Date();
  const to = isoDateUTC(toDate);
  const fromDate = new Date(toDate.getTime() - 52 * 7 * 86400000);
  return { from: isoDateUTC(fromDate), to };
}

// ─── Account discovery ────────────────────────────────────────────────────────

export async function discoverActivityAccounts(config: Config): Promise<ActivityAccount[]> {
  const accounts: ActivityAccount[] = [];
  const seen = new Set<string>();

  try {
    const gh = await getGhAccounts();
    for (const login of gh) {
      const id = `github:${login}`;
      if (seen.has(id)) continue;
      seen.add(id);
      accounts.push({
        id,
        host: "github",
        login,
        label: `GitHub · ${login}`,
      });
    }
  } catch {
    // no gh CLI
  }

  // Config may name accounts not currently listed by gh (still try token)
  const extras = [
    config.github?.defaultAccount,
    config.github?.copilotAccount,
    ...Object.values(config.github?.ownerAccounts ?? {}),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  for (const login of extras) {
    const id = `github:${login}`;
    if (seen.has(id)) continue;
    seen.add(id);
    accounts.push({ id, host: "github", login, label: `GitHub · ${login}` });
  }

  for (const [host, token] of Object.entries(config.gitlab?.tokens ?? {})) {
    if (!token) continue;
    try {
      const me = await gitlabFetchJson<{ username: string }>(host, token, "/api/v4/user");
      const login = me.username || host;
      const id = `gitlab:${host}:${login}`;
      if (seen.has(id)) continue;
      seen.add(id);
      accounts.push({
        id,
        host: "gitlab",
        login,
        gitlabHost: host,
        label: `GitLab · ${login}@${host}`,
      });
    } catch (e: any) {
      const id = `gitlab:${host}:?`;
      if (seen.has(id)) continue;
      seen.add(id);
      accounts.push({
        id,
        host: "gitlab",
        login: "?",
        gitlabHost: host,
        label: `GitLab · ${host}`,
        error: e?.message ?? "auth failed",
      });
    }
  }

  return accounts;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "git-glass",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GraphQL ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) throw new Error("GitHub GraphQL returned no data");
  return body.data;
}

async function githubRest<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "git-glass",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub REST ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

async function gitlabFetchJson<T>(host: string, token: string, path: string): Promise<T> {
  const base = host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host}`;
  const resp = await fetch(`${base}${path}`, {
    headers: {
      "PRIVATE-TOKEN": token,
      "User-Agent": "git-glass",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitLab ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

// ─── Per-account fetch ────────────────────────────────────────────────────────

interface AccountContrib {
  account: ActivityAccount;
  dayMap: Map<string, number>;
  totals: ActivityTotals;
}

const GH_CONTRIB_QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

async function fetchGithubContrib(account: ActivityAccount): Promise<AccountContrib> {
  const token = await getGhToken(account.login);
  type Gql = {
    user: {
      contributionsCollection: {
        totalCommitContributions: number;
        totalIssueContributions: number;
        totalPullRequestContributions: number;
        totalPullRequestReviewContributions: number;
        contributionCalendar: {
          totalContributions: number;
          weeks: { contributionDays: { date: string; contributionCount: number }[] }[];
        };
      };
    } | null;
  };
  const data = await githubGraphql<Gql>(token, GH_CONTRIB_QUERY, { login: account.login });
  if (!data.user) {
    throw new Error(`GitHub user not found: ${account.login}`);
  }
  const cc = data.user.contributionsCollection;
  const dayMap = new Map<string, number>();
  for (const week of cc.contributionCalendar.weeks) {
    for (const day of week.contributionDays) {
      if (day.contributionCount > 0) {
        dayMap.set(day.date, (dayMap.get(day.date) ?? 0) + day.contributionCount);
      }
    }
  }
  const totals: ActivityTotals = {
    commits: cc.totalCommitContributions,
    issues: cc.totalIssueContributions,
    pullRequests: cc.totalPullRequestContributions,
    reviews: cc.totalPullRequestReviewContributions,
    total: cc.contributionCalendar.totalContributions,
  };
  return { account, dayMap, totals };
}

async function fetchGitlabContrib(
  account: ActivityAccount,
  config: Config,
): Promise<AccountContrib> {
  const host = account.gitlabHost!;
  const token = config.gitlab?.tokens?.[host];
  if (!token) throw new Error(`No GitLab token for ${host}`);

  // Events over the last year (paginated). Contribution-like actions only.
  const dayMap = new Map<string, number>();
  const totals: ActivityTotals = {
    commits: 0,
    issues: 0,
    pullRequests: 0,
    reviews: 0,
    total: 0,
  };

  const after = isoDateUTC(new Date(Date.now() - 365 * 86400000));
  let page = 1;
  const maxPages = 10;
  while (page <= maxPages) {
    const events = await gitlabFetchJson<
      {
        action_name?: string;
        created_at?: string;
        target_type?: string | null;
        push_data?: { commit_count?: number } | null;
      }[]
    >(
      host,
      token,
      `/api/v4/events?after=${after}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events) {
      const created = ev.created_at?.slice(0, 10);
      if (!created) continue;
      const action = (ev.action_name || "").toLowerCase();
      const target = (ev.target_type || "").toLowerCase();
      let weight = 1;
      if (action === "pushed" || action === "pushed to" || action.includes("push")) {
        weight = Math.max(1, ev.push_data?.commit_count ?? 1);
        totals.commits += weight;
      } else if (target.includes("merge") || action.includes("merged") || action.includes("accepted")) {
        totals.pullRequests += 1;
      } else if (target.includes("issue") || action.includes("opened") && target === "issue") {
        totals.issues += 1;
      } else if (action.includes("approved") || action.includes("commented")) {
        totals.reviews += 1;
      } else {
        // still count as activity on the heatmap
      }
      dayMap.set(created, (dayMap.get(created) ?? 0) + weight);
      totals.total += weight;
    }
    if (events.length < 100) break;
    page++;
  }

  return { account, dayMap, totals };
}

// ─── Union ────────────────────────────────────────────────────────────────────

function emptyTotals(): ActivityTotals {
  return { commits: 0, pullRequests: 0, issues: 0, reviews: 0, total: 0 };
}

function addTotals(a: ActivityTotals, b: ActivityTotals): ActivityTotals {
  return {
    commits: a.commits + b.commits,
    pullRequests: a.pullRequests + b.pullRequests,
    issues: a.issues + b.issues,
    reviews: a.reviews + b.reviews,
    total: a.total + b.total,
  };
}

function buildDaySeries(
  contribs: AccountContrib[],
  heatmapFrom: string,
  heatmapTo: string,
): DayCount[] {
  const byDate = new Map<string, DayCount>();
  // Seed continuous range so the grid has empty days
  const start = new Date(heatmapFrom + "T00:00:00Z");
  const end = new Date(heatmapTo + "T00:00:00Z");
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    byDate.set(date, { date, count: 0, byAccount: {} });
  }
  for (const c of contribs) {
    for (const [date, count] of c.dayMap) {
      let row = byDate.get(date);
      if (!row) {
        // outside heatmap seed — skip if far outside
        if (date < heatmapFrom || date > heatmapTo) continue;
        row = { date, count: 0, byAccount: {} };
        byDate.set(date, row);
      }
      row.count += count;
      row.byAccount[c.account.id] = (row.byAccount[c.account.id] ?? 0) + count;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function filterTotalsForWindow(
  contribs: AccountContrib[],
  from: string,
  to: string,
): ActivityTotals {
  // GitHub GraphQL totals are year-scoped already for collection; for non-1y
  // windows approximate from day heatmap counts only for `total`, keep category
  // ratios from year totals scaled by day total ratio when possible.
  const yearTotals = contribs.reduce((acc, c) => addTotals(acc, c.totals), emptyTotals());
  if (from <= heatmapRange().from && to >= heatmapRange().to) return yearTotals;

  let windowDayTotal = 0;
  let yearDayTotal = 0;
  for (const c of contribs) {
    for (const [date, count] of c.dayMap) {
      yearDayTotal += count;
      if (date >= from && date <= to) windowDayTotal += count;
    }
  }
  if (yearDayTotal <= 0) {
    return { ...emptyTotals(), total: windowDayTotal };
  }
  const scale = windowDayTotal / yearDayTotal;
  return {
    commits: Math.round(yearTotals.commits * scale),
    pullRequests: Math.round(yearTotals.pullRequests * scale),
    issues: Math.round(yearTotals.issues * scale),
    reviews: Math.round(yearTotals.reviews * scale),
    total: windowDayTotal,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getActivityDashboard(
  config: Config,
  windowInput: string | undefined,
  opts?: { force?: boolean; accountIds?: string[] },
): Promise<ActivityDashboard> {
  const window = parseActivityWindow(windowInput);
  const { from, to } = rangeForWindow(window);
  const heat = heatmapRange();
  const cacheKey = `dash::${window}::${(opts?.accountIds ?? []).slice().sort().join(",")}`;
  if (!opts?.force) {
    const hit = cacheGet(dashboardCache, cacheKey);
    if (hit) return hit;
  }

  const allAccounts = await discoverActivityAccounts(config);
  const selected =
    opts?.accountIds && opts.accountIds.length > 0
      ? allAccounts.filter((a) => opts.accountIds!.includes(a.id))
      : allAccounts;

  const contribs: AccountContrib[] = [];
  const accountsOut: ActivityAccount[] = [];

  await Promise.all(
    selected.map(async (acct) => {
      try {
        const c =
          acct.host === "github"
            ? await fetchGithubContrib(acct)
            : await fetchGitlabContrib(acct, config);
        contribs.push(c);
        accountsOut.push({ ...acct });
      } catch (e: any) {
        accountsOut.push({
          ...acct,
          error: e?.message ?? "fetch failed",
        });
      }
    }),
  );

  // Include unselected accounts (disabled chips) as metadata with no data
  for (const a of allAccounts) {
    if (!accountsOut.find((x) => x.id === a.id)) {
      accountsOut.push(a);
    }
  }

  const days = buildDaySeries(contribs, heat.from, heat.to);
  const totals = filterTotalsForWindow(contribs, from, to);

  const result: ActivityDashboard = {
    window,
    generatedAt: new Date().toISOString(),
    accounts: accountsOut,
    days,
    totals,
    from,
    to,
    cacheTtlSec: ACTIVITY_CACHE_TTL_MS / 1000,
  };
  cacheSet(dashboardCache, cacheKey, result);
  return result;
}

export async function getActivityDayDetail(
  config: Config,
  date: string,
  opts?: { accountIds?: string[] },
): Promise<DayDetail> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const cacheKey = `day::${date}::${(opts?.accountIds ?? []).slice().sort().join(",")}`;
  const hit = cacheGet(dayCache, cacheKey);
  if (hit) return hit;

  const allAccounts = await discoverActivityAccounts(config);
  const selected =
    opts?.accountIds && opts.accountIds.length > 0
      ? allAccounts.filter((a) => opts.accountIds!.includes(a.id))
      : allAccounts.filter((a) => !a.error);

  const events: DayEvent[] = [];

  await Promise.all(
    selected.map(async (acct) => {
      try {
        if (acct.host === "github") {
          const token = await getGhToken(acct.login);
          // Public events (good enough for day drawer; private may be partial)
          type GhEvent = {
            id: string;
            type: string;
            created_at: string;
            repo?: { name: string };
            payload?: {
              commits?: { sha: string; message: string }[];
              pull_request?: { title: string; html_url: string; number: number };
              issue?: { title: string; html_url: string; number: number };
              review?: { html_url?: string; state?: string };
              action?: string;
              ref?: string;
            };
          };
          // Prefer private feed when token matches the user (includes private repo activity).
          let list: GhEvent[] = [];
          try {
            list = await githubRest<GhEvent[]>(
              token,
              `/users/${encodeURIComponent(acct.login)}/events/private?per_page=100`,
            );
          } catch {
            list = await githubRest<GhEvent[]>(
              token,
              `/users/${encodeURIComponent(acct.login)}/events?per_page=100`,
            );
          }
          for (const ev of list) {
            if (!ev.created_at?.startsWith(date)) continue;
            const repo = ev.repo?.name;
            if (ev.type === "PushEvent") {
              const commits = ev.payload?.commits ?? [];
              if (commits.length === 0) {
                events.push({
                  id: `${acct.id}:${ev.id}`,
                  type: "commit",
                  title: `Push${repo ? ` to ${repo}` : ""}`,
                  url: repo ? `https://github.com/${repo}` : null,
                  accountId: acct.id,
                  createdAt: ev.created_at,
                  repo,
                });
              } else {
                for (const c of commits.slice(0, 5)) {
                  events.push({
                    id: `${acct.id}:${ev.id}:${c.sha}`,
                    type: "commit",
                    title: c.message?.split("\n")[0] || c.sha.slice(0, 7),
                    url: repo ? `https://github.com/${repo}/commit/${c.sha}` : null,
                    accountId: acct.id,
                    createdAt: ev.created_at,
                    repo,
                  });
                }
              }
            } else if (ev.type === "PullRequestEvent") {
              const pr = ev.payload?.pull_request;
              events.push({
                id: `${acct.id}:${ev.id}`,
                type: "pull_request",
                title: pr?.title || `PR ${ev.payload?.action ?? ""}`.trim(),
                url: pr?.html_url ?? null,
                accountId: acct.id,
                createdAt: ev.created_at,
                repo,
              });
            } else if (ev.type === "IssuesEvent") {
              const issue = ev.payload?.issue;
              events.push({
                id: `${acct.id}:${ev.id}`,
                type: "issue",
                title: issue?.title || `Issue ${ev.payload?.action ?? ""}`.trim(),
                url: issue?.html_url ?? null,
                accountId: acct.id,
                createdAt: ev.created_at,
                repo,
              });
            } else if (ev.type === "PullRequestReviewEvent") {
              events.push({
                id: `${acct.id}:${ev.id}`,
                type: "review",
                title: `Review ${ev.payload?.review?.state ?? ""}`.trim() + (repo ? ` on ${repo}` : ""),
                url: ev.payload?.review?.html_url ?? (repo ? `https://github.com/${repo}` : null),
                accountId: acct.id,
                createdAt: ev.created_at,
                repo,
              });
            } else if (ev.type === "CreateEvent" || ev.type === "DeleteEvent") {
              events.push({
                id: `${acct.id}:${ev.id}`,
                type: "other",
                title: `${ev.type.replace("Event", "")}${repo ? ` · ${repo}` : ""}`,
                url: repo ? `https://github.com/${repo}` : null,
                accountId: acct.id,
                createdAt: ev.created_at,
                repo,
              });
            }
          }
        } else if (acct.host === "gitlab" && acct.gitlabHost) {
          const token = config.gitlab?.tokens?.[acct.gitlabHost];
          if (!token) return;
          type GlEvent = {
            id: number;
            action_name?: string;
            created_at?: string;
            target_title?: string;
            target_type?: string;
            project_id?: number;
          };
          const list = await gitlabFetchJson<GlEvent[]>(
            acct.gitlabHost,
            token,
            `/api/v4/events?after=${date}&before=${date}T23:59:59Z&per_page=100`,
          );
          for (const ev of list) {
            if (!ev.created_at?.startsWith(date)) continue;
            const action = (ev.action_name || "event").toLowerCase();
            let type: DayEvent["type"] = "other";
            if (action.includes("push")) type = "commit";
            else if (action.includes("merge") || (ev.target_type || "").toLowerCase().includes("merge"))
              type = "pull_request";
            else if ((ev.target_type || "").toLowerCase().includes("issue")) type = "issue";
            else if (action.includes("approved") || action.includes("commented")) type = "review";
            events.push({
              id: `${acct.id}:${ev.id}`,
              type,
              title: ev.target_title || action,
              url: null,
              accountId: acct.id,
              createdAt: ev.created_at,
            });
          }
        }
      } catch {
        // soft-fail per account
      }
    }),
  );

  events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const result: DayDetail = {
    date,
    events,
    generatedAt: new Date().toISOString(),
  };
  cacheSet(dayCache, cacheKey, result);
  return result;
}
