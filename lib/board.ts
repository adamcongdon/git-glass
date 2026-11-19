/**
 * lib/board.ts
 *
 * Inbox Board + Merge order: every open PR/MR and issue on local remotes,
 * grouped per repo. Each PR/MR carries the reasons it is stuck, so the
 * healthy steady state (a bot merges or closes almost everything) reads as a
 * nearly empty board and anything in trouble rises to the top.
 *
 * Read-only. No fixed per-repo cap: PR/MR lists paginate up to MAX_MR_PAGES
 * and say when they stopped early.
 */

import { getGhAccounts, getGhToken } from "./gh";
import { discoverLocalRemotes, type LocalRemote } from "./issues";
import { pMap } from "./gitStatus";
import type { Config } from "./config";
import { excludeHiddenRows } from "./inboxHide";
import { remoteToWebUrl } from "./remoteUrl";

// ─── Types ────────────────────────────────────────────────────────────────────

export type StuckReason =
  | "checks_failing"
  | "checks_pending"
  | "conflict"
  | "changes_requested"
  | "needs_review"
  | "draft"
  | "behind"
  | "old";

/** Display order: the worst problem first. */
export const STUCK_REASON_ORDER: StuckReason[] = [
  "checks_failing",
  "conflict",
  "changes_requested",
  "behind",
  "checks_pending",
  "needs_review",
  "draft",
  "old",
];

export interface BoardMr {
  id: string;
  host: string;
  hostType: "github" | "gitlab";
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  mine: boolean;
  bot: boolean;
  sourceBranch: string | null;
  labels: string[];
  reasons: StuckReason[];
  stuck: boolean;
  ageDays: number;
}

export interface BoardIssue {
  id: string;
  host: string;
  hostType: "github" | "gitlab";
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  mine: boolean;
  ageDays: number;
}

export interface RepoHealth {
  openMrs: number;
  stuck: number;
  oldestDays: number | null;
  openIssues: number;
  botMrs: number;
}

export interface BoardRepo {
  key: string;
  host: string;
  hostType: "github" | "gitlab";
  owner: string;
  repo: string;
  localPath: string;
  webUrl: string | null;
  mrs: BoardMr[];
  issues: BoardIssue[];
  /** Issues beyond the first page; the UI links out for the rest. */
  moreIssues: number;
  /** True when the MR list stopped at MAX_MR_PAGES. */
  mrsTruncated: boolean;
  health: RepoHealth;
  error?: string;
}

export interface BoardFailure {
  host: string;
  remote?: string;
  message: string;
}

export interface BoardResult {
  repos: BoardRepo[];
  generatedAt: string;
  cached: boolean;
  failures: BoardFailure[];
  hiddenCount: number;
  staleDays: number;
}

export interface BotRules {
  markers: string[];
  authors: string[];
  branchPrefixes: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const FETCH_CONCURRENCY = 6;
const MR_PAGE_SIZE = 50;
const MAX_MR_PAGES = 6;
const ISSUE_PAGE_SIZE = 50;
const GL_NOTES_PER_MR = 20;
const DAY_MS = 86_400_000;

let cache: { repos: BoardRepo[]; failures: BoardFailure[]; storedAt: number; staleDays: number } | null =
  null;

export function clearBoardCache(): void {
  cache = null;
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────────

export function ageInDays(iso: string, nowMs = Date.now()): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

function orderReasons(set: Set<StuckReason>): StuckReason[] {
  return STUCK_REASON_ORDER.filter((r) => set.has(r));
}

export interface GhStuckInput {
  isDraft: boolean;
  /** GraphQL `mergeable`: MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable?: string | null;
  /** GraphQL `mergeStateStatus`: BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE */
  mergeStateStatus?: string | null;
  /** GraphQL `reviewDecision`: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
  reviewDecision?: string | null;
  /** statusCheckRollup.state on the head commit: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null */
  checkState?: string | null;
  createdAt: string;
}

export function ghStuckReasons(
  input: GhStuckInput,
  staleDays: number,
  nowMs = Date.now(),
): StuckReason[] {
  const r = new Set<StuckReason>();
  const check = (input.checkState ?? "").toUpperCase();
  if (check === "FAILURE" || check === "ERROR") r.add("checks_failing");
  if (check === "PENDING" || check === "EXPECTED") r.add("checks_pending");
  const mergeable = (input.mergeable ?? "").toUpperCase();
  const mss = (input.mergeStateStatus ?? "").toUpperCase();
  if (mergeable === "CONFLICTING" || mss === "DIRTY") r.add("conflict");
  if (mss === "BEHIND") r.add("behind");
  const review = (input.reviewDecision ?? "").toUpperCase();
  if (review === "CHANGES_REQUESTED") r.add("changes_requested");
  if (review === "REVIEW_REQUIRED") r.add("needs_review");
  if (input.isDraft || mss === "DRAFT") r.add("draft");
  if (ageInDays(input.createdAt, nowMs) > staleDays) r.add("old");
  return orderReasons(r);
}

export interface GlStuckInput {
  draft: boolean;
  hasConflicts?: boolean;
  /** GitLab `detailed_merge_status` */
  detailedMergeStatus?: string | null;
  /** head_pipeline.status when known: success | failed | running | pending | created | canceled | skipped | manual */
  pipelineStatus?: string | null;
  createdAt: string;
}

export function glStuckReasons(
  input: GlStuckInput,
  staleDays: number,
  nowMs = Date.now(),
): StuckReason[] {
  const r = new Set<StuckReason>();
  const st = (input.detailedMergeStatus ?? "").toLowerCase();
  const pipe = (input.pipelineStatus ?? "").toLowerCase();
  if (pipe === "failed" || pipe === "canceled") r.add("checks_failing");
  else if (pipe === "running" || pipe === "pending" || pipe === "created" || pipe === "waiting_for_resource" || pipe === "preparing")
    r.add("checks_pending");
  if (st === "ci_still_running") r.add("checks_pending");
  if (st === "ci_must_pass" && !r.has("checks_pending")) r.add("checks_failing");
  if (input.hasConflicts || st === "conflict") r.add("conflict");
  if (st === "need_rebase") r.add("behind");
  if (st === "requested_changes") r.add("changes_requested");
  if (st === "not_approved" || st === "discussions_not_resolved") r.add("needs_review");
  if (input.draft || st === "draft_status") r.add("draft");
  if (ageInDays(input.createdAt, nowMs) > staleDays) r.add("old");
  return orderReasons(r);
}

export interface BotInput {
  author?: string | null;
  body?: string | null;
  branch?: string | null;
  comments?: string[];
}

/** True when the MR was opened by, or carries a marker of, the triage bot. */
export function isBotTouched(input: BotInput, rules: BotRules): boolean {
  const author = (input.author ?? "").toLowerCase();
  if (author && rules.authors.some((a) => a.toLowerCase() === author)) return true;
  const branch = input.branch ?? "";
  if (branch && rules.branchPrefixes.some((p) => branch.startsWith(p))) return true;
  const markers = rules.markers.map((m) => m.toLowerCase()).filter(Boolean);
  if (markers.length === 0) return false;
  const texts = [input.body ?? "", ...(input.comments ?? [])];
  return texts.some((t) => {
    const lower = t.toLowerCase();
    return markers.some((m) => lower.includes(m));
  });
}

/** Stuck first, then oldest first within each group (or newest first). */
export function sortMrs<T extends { stuck: boolean; createdAt: string; number: number }>(
  mrs: T[],
  opts: { direction?: "asc" | "desc"; stuckFirst?: boolean } = {},
): T[] {
  const dir = opts.direction === "desc" ? -1 : 1;
  const stuckFirst = opts.stuckFirst !== false;
  return [...mrs].sort((a, b) => {
    if (stuckFirst && a.stuck !== b.stuck) return a.stuck ? -1 : 1;
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    if (ta !== tb) return (ta - tb) * dir;
    return (a.number - b.number) * dir;
  });
}

export function repoHealth(mrs: BoardMr[], openIssues: number): RepoHealth {
  let oldest: number | null = null;
  for (const m of mrs) if (oldest === null || m.ageDays > oldest) oldest = m.ageDays;
  return {
    openMrs: mrs.length,
    stuck: mrs.filter((m) => m.stuck).length,
    oldestDays: oldest,
    openIssues,
    botMrs: mrs.filter((m) => m.bot).length,
  };
}

/** Repos in trouble first, then busiest, then quiet repos by name. */
export function sortRepos(repos: BoardRepo[]): BoardRepo[] {
  return [...repos].sort((a, b) => {
    const ea = a.error ? 1 : 0;
    const eb = b.error ? 1 : 0;
    if (a.health.stuck !== b.health.stuck) return b.health.stuck - a.health.stuck;
    const oa = a.health.oldestDays ?? -1;
    const ob = b.health.oldestDays ?? -1;
    if (a.health.stuck > 0 && oa !== ob) return ob - oa;
    const ba = a.health.openMrs + a.health.openIssues;
    const bb = b.health.openMrs + b.health.openIssues;
    if ((ba > 0) !== (bb > 0)) return ba > 0 ? -1 : 1;
    if (ea !== eb) return eb - ea;
    if (ba !== bb) return bb - ba;
    return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
  });
}

/** One remote per host/owner/repo (several local clones of one repo are common). */
export function dedupeRemotes(remotes: LocalRemote[]): LocalRemote[] {
  const seen = new Map<string, LocalRemote>();
  for (const r of remotes) {
    const k = `${r.host.toLowerCase()}/${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

// ─── GitHub (GraphQL, one query per page per repo) ────────────────────────────

const GH_QUERY = `query($owner:String!,$name:String!,$cursor:String,$withIssues:Boolean!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:${MR_PAGE_SIZE},after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title url createdAt updatedAt isDraft headRefName body
        author{login}
        mergeable mergeStateStatus reviewDecision
        labels(first:10){nodes{name}}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
        comments(last:20){nodes{body}}
      }
    }
    issues(states:OPEN,first:${ISSUE_PAGE_SIZE},orderBy:{field:CREATED_AT,direction:ASC}) @include(if:$withIssues){
      totalCount
      nodes{number title url createdAt updatedAt author{login} labels(first:10){nodes{name}}}
    }
  }
}`;

async function ghGraphql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // mergeStateStatus was a preview field; harmless where it is GA.
      Accept: "application/vnd.github.merge-info-preview+json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`GitHub ${resp.status}: ${data?.message ?? "request failed"}`);
  if (data?.errors?.length) throw new Error(`GitHub: ${data.errors[0]?.message ?? "GraphQL error"}`);
  return data?.data;
}

const ghLoginCache = new Map<string, string | null>();
async function ghLogin(token: string): Promise<string | null> {
  if (ghLoginCache.has(token)) return ghLoginCache.get(token)!;
  try {
    const d = await ghGraphql(token, "query{viewer{login}}", {});
    const login = d?.viewer?.login ?? null;
    ghLoginCache.set(token, login);
    return login;
  } catch {
    return null;
  }
}

function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function mapGhPr(
  raw: any,
  remote: LocalRemote,
  ctx: { login: string | null; staleDays: number; bot: BotRules; nowMs?: number },
): BoardMr {
  const nowMs = ctx.nowMs ?? Date.now();
  const author = raw?.author?.login ?? null;
  const checkState = raw?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  const reasons = ghStuckReasons(
    {
      isDraft: !!raw?.isDraft,
      mergeable: raw?.mergeable,
      mergeStateStatus: raw?.mergeStateStatus,
      reviewDecision: raw?.reviewDecision,
      checkState,
      createdAt: raw?.createdAt ?? "",
    },
    ctx.staleDays,
    nowMs,
  );
  return {
    id: `${remote.host}/${remote.owner}/${remote.repo}!${raw.number}`,
    host: remote.host,
    hostType: "github",
    owner: remote.owner,
    repo: remote.repo,
    number: raw.number,
    title: raw.title ?? "",
    htmlUrl: raw.url ?? "",
    author,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? raw.createdAt ?? "",
    draft: !!raw.isDraft,
    mine: sameUser(author, ctx.login),
    bot: isBotTouched(
      {
        author,
        body: raw.body,
        branch: raw.headRefName,
        comments: (raw?.comments?.nodes ?? []).map((n: any) => n?.body ?? ""),
      },
      ctx.bot,
    ),
    sourceBranch: raw.headRefName ?? null,
    labels: (raw?.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean),
    reasons,
    stuck: reasons.length > 0,
    ageDays: ageInDays(raw.createdAt ?? "", nowMs),
  };
}

async function loadGhRepo(
  remote: LocalRemote,
  token: string,
  ctx: { staleDays: number; bot: BotRules },
): Promise<Omit<BoardRepo, "health" | "key" | "localPath" | "webUrl">> {
  const login = await ghLogin(token);
  const mrs: BoardMr[] = [];
  const issues: BoardIssue[] = [];
  let moreIssues = 0;
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;
  while (true) {
    const d = await ghGraphql(token, GH_QUERY, {
      owner: remote.owner,
      name: remote.repo,
      cursor,
      withIssues: pages === 0,
    });
    const repo = d?.repository;
    if (!repo) throw new Error("GitHub: repository not found or no access");
    for (const n of repo.pullRequests?.nodes ?? []) mrs.push(mapGhPr(n, remote, { login, ...ctx }));
    if (pages === 0 && repo.issues) {
      for (const n of repo.issues.nodes ?? []) {
        const author = n?.author?.login ?? null;
        issues.push({
          id: `${remote.host}/${remote.owner}/${remote.repo}#${n.number}`,
          host: remote.host,
          hostType: "github",
          owner: remote.owner,
          repo: remote.repo,
          number: n.number,
          title: n.title ?? "",
          htmlUrl: n.url ?? "",
          author,
          createdAt: n.createdAt ?? "",
          updatedAt: n.updatedAt ?? n.createdAt ?? "",
          labels: (n?.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean),
          mine: sameUser(author, login),
          ageDays: ageInDays(n.createdAt ?? ""),
        });
      }
      moreIssues = Math.max(0, (repo.issues.totalCount ?? issues.length) - issues.length);
    }
    pages++;
    const info = repo.pullRequests?.pageInfo;
    if (!info?.hasNextPage) break;
    if (pages >= MAX_MR_PAGES) {
      truncated = true;
      break;
    }
    cursor = info.endCursor;
  }
  return {
    host: remote.host,
    hostType: "github",
    owner: remote.owner,
    repo: remote.repo,
    mrs,
    issues,
    moreIssues,
    mrsTruncated: truncated,
  };
}

// ─── GitLab (REST, paginated) ─────────────────────────────────────────────────

async function glGet(url: string, token: string): Promise<{ data: any; headers: Headers }> {
  const resp = await fetch(url, {
    headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`GitLab ${resp.status}: ${data?.message ?? data?.error ?? "request failed"}`);
  return { data, headers: resp.headers };
}

function glProject(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

const glLoginCache = new Map<string, string | null>();
async function glLogin(host: string, token: string): Promise<string | null> {
  const k = `${host}::${token.slice(-6)}`;
  if (glLoginCache.has(k)) return glLoginCache.get(k)!;
  try {
    const { data } = await glGet(`https://${host}/api/v4/user`, token);
    const login = data?.username ?? null;
    glLoginCache.set(k, login);
    return login;
  } catch {
    return null;
  }
}

export function mapGlMr(
  raw: any,
  remote: LocalRemote,
  ctx: { login: string | null; staleDays: number; bot: BotRules; comments?: string[]; nowMs?: number },
): BoardMr {
  const nowMs = ctx.nowMs ?? Date.now();
  const author = raw?.author?.username ?? null;
  const draft = !!(raw?.draft ?? raw?.work_in_progress);
  const reasons = glStuckReasons(
    {
      draft,
      hasConflicts: !!raw?.has_conflicts,
      detailedMergeStatus: raw?.detailed_merge_status ?? null,
      pipelineStatus: raw?.head_pipeline?.status ?? raw?.pipeline?.status ?? null,
      createdAt: raw?.created_at ?? "",
    },
    ctx.staleDays,
    nowMs,
  );
  return {
    id: `${remote.host}/${remote.owner}/${remote.repo}!${raw.iid}`,
    host: remote.host,
    hostType: "gitlab",
    owner: remote.owner,
    repo: remote.repo,
    number: raw.iid,
    title: raw.title ?? "",
    htmlUrl: raw.web_url ?? "",
    author,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? raw.created_at ?? "",
    draft,
    mine: sameUser(author, ctx.login),
    bot: isBotTouched(
      { author, body: raw.description, branch: raw.source_branch, comments: ctx.comments ?? [] },
      ctx.bot,
    ),
    sourceBranch: raw.source_branch ?? null,
    labels: Array.isArray(raw.labels) ? raw.labels.filter((l: any) => typeof l === "string") : [],
    reasons,
    stuck: reasons.length > 0,
    ageDays: ageInDays(raw.created_at ?? "", nowMs),
  };
}

async function loadGlRepo(
  remote: LocalRemote,
  token: string,
  ctx: { staleDays: number; bot: BotRules },
): Promise<Omit<BoardRepo, "health" | "key" | "localPath" | "webUrl">> {
  const base = `https://${remote.host}/api/v4/projects/${glProject(remote.owner, remote.repo)}`;
  const login = await glLogin(remote.host, token);
  const raws: any[] = [];
  let page = 1;
  let truncated = false;
  while (true) {
    const { data, headers } = await glGet(
      `${base}/merge_requests?state=opened&per_page=${MR_PAGE_SIZE}&page=${page}&order_by=created_at&sort=asc`,
      token,
    );
    if (Array.isArray(data)) raws.push(...data);
    const next = headers.get("x-next-page");
    if (!next) break;
    if (page >= MAX_MR_PAGES) {
      truncated = true;
      break;
    }
    page = Number(next) || page + 1;
  }
  const mrs = await pMap(
    raws,
    async (raw) => {
      let comments: string[] = [];
      if (ctx.bot.markers.length > 0) {
        try {
          const { data } = await glGet(
            `${base}/merge_requests/${raw.iid}/notes?per_page=${GL_NOTES_PER_MR}&sort=desc&order_by=updated_at`,
            token,
          );
          if (Array.isArray(data)) comments = data.map((n: any) => n?.body ?? "");
        } catch {
          // notes are best-effort; the badge falls back to body/author/branch
        }
      }
      return mapGlMr(raw, remote, { login, ...ctx, comments });
    },
    4,
  );

  const issues: BoardIssue[] = [];
  let moreIssues = 0;
  try {
    const { data, headers } = await glGet(
      `${base}/issues?state=opened&per_page=${ISSUE_PAGE_SIZE}&order_by=created_at&sort=asc`,
      token,
    );
    for (const n of Array.isArray(data) ? data : []) {
      const author = n?.author?.username ?? null;
      issues.push({
        id: `${remote.host}/${remote.owner}/${remote.repo}#${n.iid}`,
        host: remote.host,
        hostType: "gitlab",
        owner: remote.owner,
        repo: remote.repo,
        number: n.iid,
        title: n.title ?? "",
        htmlUrl: n.web_url ?? "",
        author,
        createdAt: n.created_at ?? "",
        updatedAt: n.updated_at ?? n.created_at ?? "",
        labels: Array.isArray(n.labels) ? n.labels.filter((l: any) => typeof l === "string") : [],
        mine: sameUser(author, login),
        ageDays: ageInDays(n.created_at ?? ""),
      });
    }
    const total = Number(headers.get("x-total"));
    if (Number.isFinite(total)) moreIssues = Math.max(0, total - issues.length);
  } catch {
    // issues disabled on the project, or no access: leave the lane empty
  }
  return {
    host: remote.host,
    hostType: "gitlab",
    owner: remote.owner,
    repo: remote.repo,
    mrs,
    issues,
    moreIssues,
    mrsTruncated: truncated,
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

function resolveGithubAccount(owner: string, config: Config, available: string[]): string | undefined {
  const mapped = config.github.ownerAccounts[owner.toLowerCase()];
  if (mapped) return mapped;
  if (config.github.defaultAccount) return config.github.defaultAccount;
  return available[0];
}

export type RepoLoader = (
  remote: LocalRemote,
) => Promise<Omit<BoardRepo, "health" | "key" | "localPath" | "webUrl">>;

/**
 * Load every repo with bounded concurrency. One repo failing never blanks the
 * board: it becomes a band with `error` set plus a row in `failures`.
 */
export async function assembleBoard(
  remotes: LocalRemote[],
  loader: RepoLoader,
  opts: { staleDays: number },
): Promise<{ repos: BoardRepo[]; failures: BoardFailure[] }> {
  const failures: BoardFailure[] = [];
  const repos = await pMap(
    remotes,
    async (remote): Promise<BoardRepo> => {
      const key = `${remote.host}/${remote.owner}/${remote.repo}`;
      const base = {
        key,
        host: remote.host,
        hostType: remote.hostType,
        owner: remote.owner,
        repo: remote.repo,
        localPath: remote.path,
        webUrl: remoteToWebUrl(remote.remoteUrl),
      };
      try {
        const r = await loader(remote);
        const mrs = sortMrs(r.mrs);
        const issues = [...r.issues].sort(
          (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
        );
        return {
          ...base,
          mrs,
          issues,
          moreIssues: r.moreIssues,
          mrsTruncated: r.mrsTruncated,
          health: repoHealth(mrs, issues.length + r.moreIssues),
        };
      } catch (err: any) {
        const message = String(err?.message ?? err ?? "load failed");
        failures.push({ host: remote.host, remote: `${remote.owner}/${remote.repo}`, message });
        return {
          ...base,
          mrs: [],
          issues: [],
          moreIssues: 0,
          mrsTruncated: false,
          health: repoHealth([], 0),
          error: message,
        };
      }
    },
    FETCH_CONCURRENCY,
  );
  void opts;
  return { repos: sortRepos(repos), failures };
}

async function loadBoard(config: Config): Promise<{ repos: BoardRepo[]; failures: BoardFailure[] }> {
  const staleDays = config.inbox?.staleDays ?? 7;
  const bot: BotRules = {
    markers: config.inbox?.bot?.markers ?? [],
    authors: config.inbox?.bot?.authors ?? [],
    branchPrefixes: config.inbox?.bot?.branchPrefixes ?? [],
  };
  const remotes = dedupeRemotes(await discoverLocalRemotes(config.scanPaths, config.ignoredRepos));
  const accounts = await getGhAccounts().catch(() => [] as string[]);
  const tokenCache = new Map<string, Promise<string>>();
  const ghToken = (account: string | undefined) => {
    const k = account ?? "";
    if (!tokenCache.has(k)) tokenCache.set(k, getGhToken(account));
    return tokenCache.get(k)!;
  };
  const loader: RepoLoader = async (remote) => {
    if (remote.hostType === "github") {
      const token = await ghToken(resolveGithubAccount(remote.owner, config, accounts));
      return loadGhRepo(remote, token, { staleDays, bot });
    }
    const token = config.gitlab.tokens[remote.host] ?? config.gitlab.tokens[remote.host.toLowerCase()];
    if (!token) throw new Error(`No GitLab token for ${remote.host} (Settings → GitLab)`);
    return loadGlRepo(remote, token, { staleDays, bot });
  };
  return assembleBoard(remotes, loader, { staleDays });
}

export async function getBoard(config: Config, opts: { force?: boolean } = {}): Promise<BoardResult> {
  const now = Date.now();
  const staleDays = config.inbox?.staleDays ?? 7;
  let cached = false;
  if (!opts.force && cache && now - cache.storedAt < CACHE_TTL_MS && cache.staleDays === staleDays) {
    cached = true;
  } else {
    const loaded = await loadBoard(config);
    cache = { ...loaded, storedAt: now, staleDays };
  }
  const hidden = config.inbox?.hiddenRepos ?? [];
  return {
    repos: excludeHiddenRows(cache!.repos, hidden),
    generatedAt: new Date(cache!.storedAt).toISOString(),
    cached,
    failures: cache!.failures,
    hiddenCount: hidden.length,
    staleDays,
  };
}
