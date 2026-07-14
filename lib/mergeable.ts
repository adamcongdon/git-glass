/**
 * lib/mergeable.ts
 *
 * Ship queue: open PRs/MRs on local remotes where user is author or can merge.
 * Ready = checks clean + approved + not behind + mergeable.
 * Merge only after live re-validation; no admin bypass; no bulk.
 */

import { getGhAccounts, getGhToken } from "./gh";
import {
  discoverLocalRemotes,
  remoteKey,
  type LocalRemote,
} from "./issues";
import { pMap } from "./gitStatus";
import type { Config } from "./config";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MergeMethod = "merge" | "squash" | "rebase";

export interface ReadyFlags {
  checksClean: boolean;
  approved: boolean;
  notBehind: boolean;
  mergeable: boolean;
}

export interface MergeableRow {
  id: string;
  host: string;
  hostType: "github" | "gitlab";
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  account: string | null;
  author: string;
  ready: boolean;
  reasons: string[];
  mergeableState: string;
  checksClean: boolean;
  approved: boolean;
  notBehind: boolean;
  allowedMethods: MergeMethod[];
  defaultMethod: MergeMethod;
  deleteBranchDefault: boolean;
  commitTitleDefault: string;
  commitMessageDefault: string;
}

export interface MergeableFailure {
  host: string;
  remote?: string;
  message: string;
}

export interface MergeableResult {
  items: MergeableRow[];
  generatedAt: string;
  cached: boolean;
  failures: MergeableFailure[];
}

export interface MergeInput {
  hostType: "github" | "gitlab";
  host: string;
  owner: string;
  repo: string;
  number: number;
  account?: string;
  method: MergeMethod;
  commitTitle?: string;
  commitMessage?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const FETCH_CONCURRENCY = 6;
const PR_LIST_CAP = 15;
/** Cap detailed status fetches across all repos per load (rate-limit / latency). */
const DETAIL_CAP = 40;

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheBag {
  items: MergeableRow[];
  failures: MergeableFailure[];
  storedAt: number;
}

let cache: CacheBag | null = null;

export function clearMergeableCache(): void {
  cache = null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function isReady(flags: ReadyFlags): boolean {
  return flags.checksClean && flags.approved && flags.notBehind && flags.mergeable;
}

export function reasonsNotReady(flags: ReadyFlags): string[] {
  const r: string[] = [];
  if (!flags.checksClean) r.push("checks failing");
  if (!flags.approved) r.push("not approved");
  if (!flags.notBehind) r.push("behind base");
  if (!flags.mergeable) r.push("not mergeable");
  return r;
}

export function pickDefaultMethod(
  allowed: MergeMethod[],
  remembered?: MergeMethod | null,
): MergeMethod {
  if (remembered && allowed.includes(remembered)) return remembered;
  if (allowed.length > 0) return allowed[0];
  return "merge";
}

export function mapGhMergeability(input: {
  mergeable: boolean | null;
  mergeable_state: string | null;
  draft: boolean;
  reviewDecision: string | null;
  checksConclusion: string | null;
  behindBy: number;
}): ReadyFlags {
  const state = (input.mergeable_state ?? "").toLowerCase();
  const mergeable =
    input.mergeable === true && !input.draft && state !== "dirty" && state !== "blocked";

  // clean / has_hooks → up to date; behind / unknown with behindBy → not
  let notBehind = true;
  if (state === "behind") notBehind = false;
  else if (state === "clean" || state === "has_hooks") notBehind = true;
  else if (state === "unknown" || (input.behindBy ?? 0) > 0) notBehind = (input.behindBy ?? 0) === 0;
  else if (state === "dirty" || state === "blocked") notBehind = false;

  const checksClean =
    input.checksConclusion === "success" ||
    input.checksConclusion === "neutral" ||
    input.checksConclusion === "skipped" ||
    input.checksConclusion === null ||
    input.checksConclusion === "none";
  // unstable often means non-required checks failed — still require clean-ish
  const checksFinal =
    state === "unstable"
      ? input.checksConclusion === "success" || input.checksConclusion === "neutral"
      : state === "clean"
        ? true
        : checksClean;
  const decision = (input.reviewDecision ?? "").toUpperCase();
  const approved =
    decision === "APPROVED" ||
    decision === "" || // no review required
    decision === "NONE";
  // CHANGES_REQUESTED / REVIEW_REQUIRED block
  const approvedFinal =
    decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED"
      ? false
      : approved;

  return {
    checksClean: input.draft ? false : checksFinal,
    approved: approvedFinal,
    notBehind,
    // Draft is never mergeable even if mergeable_state reports clean
    mergeable: input.draft ? false : mergeable || state === "clean",
  };
}

export function mapGlMergeability(input: {
  detailed_merge_status: string | null;
  draft: boolean;
  has_conflicts: boolean;
  approvalsLeft: number;
  pipelineStatus: string | null;
  divergedCommitsCount: number;
}): ReadyFlags {
  const status = (input.detailed_merge_status ?? "").toLowerCase();
  const mergeable =
    !input.draft &&
    !input.has_conflicts &&
    (status === "mergeable" || status === "can_be_merged" || status === "");
  const notBehind =
    status !== "need_rebase" &&
    status !== "ci_must_pass" &&
    (input.divergedCommitsCount ?? 0) === 0;
  const notBehindFinal =
    status === "need_rebase" ? false : status === "mergeable" ? true : notBehind;
  const pipe = (input.pipelineStatus ?? "").toLowerCase();
  const checksClean =
    pipe === "success" || pipe === "skipped" || pipe === "" || pipe === "manual" || pipe === "null";
  const approved = (input.approvalsLeft ?? 0) <= 0;

  return {
    checksClean: status === "ci_must_pass" ? false : checksClean,
    approved: status === "not_approved" ? false : approved,
    notBehind: notBehindFinal,
    mergeable: status === "conflict" || status === "checking" ? false : mergeable,
  };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

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
      "Content-Type": "application/json",
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

async function ghWhoAmI(token: string): Promise<string | null> {
  const { ok, data } = await ghFetch("https://api.github.com/user", token);
  if (!ok) return null;
  return data?.login ?? null;
}

async function ghCanMerge(
  owner: string,
  repo: string,
  login: string,
  token: string,
): Promise<boolean> {
  const { ok, data } = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
    token,
  );
  if (!ok) return false;
  const p = String(data?.permission ?? "").toLowerCase();
  return p === "admin" || p === "maintain" || p === "write";
}

async function fetchGhChecksConclusion(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const { ok, data } = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    token,
  );
  if (!ok || !data?.check_runs) return null;
  const runs: any[] = data.check_runs;
  if (runs.length === 0) return "none";
  const conclusions = runs.map((r) => String(r.conclusion ?? r.status ?? "").toLowerCase());
  if (conclusions.some((c) => c === "failure" || c === "timed_out" || c === "cancelled")) {
    return "failure";
  }
  if (conclusions.some((c) => c === "in_progress" || c === "queued" || c === "pending")) {
    return "pending";
  }
  if (conclusions.every((c) => c === "success" || c === "neutral" || c === "skipped" || c === "completed")) {
    return "success";
  }
  return conclusions[0] ?? null;
}

async function buildGhMergeableRow(
  remote: LocalRemote,
  pr: any,
  token: string,
  account: string | null,
  login: string | null,
): Promise<MergeableRow | null> {
  const number = pr.number;
  if (typeof number !== "number") return null;
  const author = String(pr.user?.login ?? "");
  const isAuthor = login && author.toLowerCase() === login.toLowerCase();
  if (!isAuthor) {
    const can = login ? await ghCanMerge(remote.owner, remote.repo, login, token) : false;
    if (!can) return null;
  }

  // Detailed PR for mergeable_state + review decision
  const { ok, data: detail } = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pulls/${number}`,
    token,
  );
  if (!ok || !detail) return null;

  const headSha = detail.head?.sha ?? pr.head?.sha ?? "";
  const checksConclusion = headSha
    ? await fetchGhChecksConclusion(remote.owner, remote.repo, headSha, token)
    : null;

  // reviewDecision from GraphQL is better; REST: list reviews
  let reviewDecision: string | null = detail.requested_reviewers?.length ? "REVIEW_REQUIRED" : "";
  {
    const { ok: rok, data: reviews } = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pulls/${number}/reviews`,
      token,
    );
    if (rok && Array.isArray(reviews)) {
      // latest review per user
      const latest = new Map<string, string>();
      for (const rev of reviews) {
        const u = rev.user?.login;
        if (!u) continue;
        latest.set(u, String(rev.state ?? ""));
      }
      const states = [...latest.values()];
      if (states.some((s) => s === "CHANGES_REQUESTED")) reviewDecision = "CHANGES_REQUESTED";
      else if (states.some((s) => s === "APPROVED")) reviewDecision = "APPROVED";
      else if (detail.requested_reviewers?.length) reviewDecision = "REVIEW_REQUIRED";
      else reviewDecision = "NONE";
    }
  }

  // Repo settings for methods + delete branch
  let allowedMethods: MergeMethod[] = ["merge", "squash", "rebase"];
  let deleteBranchDefault = false;
  {
    const { ok: ro, data: repo } = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`,
      token,
    );
    if (ro && repo) {
      allowedMethods = [];
      if (repo.allow_merge_commit !== false) allowedMethods.push("merge");
      if (repo.allow_squash_merge !== false) allowedMethods.push("squash");
      if (repo.allow_rebase_merge !== false) allowedMethods.push("rebase");
      if (allowedMethods.length === 0) allowedMethods = ["merge"];
      deleteBranchDefault = repo.delete_branch_on_merge === true;
    }
  }

  const flags = mapGhMergeability({
    mergeable: detail.mergeable,
    mergeable_state: detail.mergeable_state,
    draft: detail.draft === true,
    reviewDecision,
    checksConclusion,
    behindBy: 0,
  });
  // pending checks → not clean
  if (checksConclusion === "pending") flags.checksClean = false;
  if (checksConclusion === "failure") flags.checksClean = false;

  const title = String(detail.title ?? pr.title ?? "");
  const commitTitleDefault =
    allowedMethods[0] === "squash" ? `${title} (#${number})` : `Merge pull request #${number} from ${detail.head?.label ?? "branch"}`;
  const commitMessageDefault = String(detail.body ?? "").slice(0, 2000);

  return {
    id: `gh:${remote.owner}/${remote.repo}#${number}`,
    host: remote.host,
    hostType: "github",
    owner: remote.owner,
    repo: remote.repo,
    number,
    title,
    htmlUrl: String(detail.html_url ?? pr.html_url),
    account,
    author,
    ready: isReady(flags),
    reasons: reasonsNotReady(flags),
    mergeableState: String(detail.mergeable_state ?? ""),
    checksClean: flags.checksClean,
    approved: flags.approved,
    notBehind: flags.notBehind,
    allowedMethods,
    defaultMethod: pickDefaultMethod(allowedMethods),
    deleteBranchDefault,
    commitTitleDefault,
    commitMessageDefault,
  };
}

/** Fast path: open PRs authored by the authenticated user, intersect local remotes. */
async function fetchGhAuthorMergeable(
  token: string,
  account: string | null,
  login: string | null,
  localKeys: Map<string, LocalRemote>,
  detailBudget: { left: number },
): Promise<{ items: MergeableRow[]; error?: string }> {
  const q = "is:pr is:open author:@me";
  const url =
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
    `&sort=updated&order=desc&per_page=50`;
  const { ok, status, data } = await ghFetch(url, token);
  if (!ok) {
    return { items: [], error: `GitHub search ${status}: ${data?.message ?? "failed"}` };
  }
  const list = Array.isArray(data?.items) ? data.items : [];
  const items: MergeableRow[] = [];
  for (const raw of list) {
    if (detailBudget.left <= 0) break;
    const repoUrl: string = raw.repository_url ?? "";
    const m = repoUrl.match(/repos\/([^/]+)\/([^/#?]+)/);
    if (!m) continue;
    const owner = m[1];
    const repo = m[2];
    const remote = localKeys.get(remoteKey(owner, repo));
    if (!remote) continue;
    detailBudget.left -= 1;
    try {
      const row = await buildGhMergeableRow(remote, raw, token, account, login);
      if (row) items.push(row);
    } catch {
      // skip
    }
  }
  return { items };
}

async function fetchGhRepoMergeable(
  remote: LocalRemote,
  token: string,
  account: string | null,
  login: string | null,
  canMerge: boolean,
  detailBudget: { left: number },
): Promise<{ items: MergeableRow[]; error?: string }> {
  if (detailBudget.left <= 0) return { items: [] };
  const { ok, status, data } = await ghFetch(
    `https://api.github.com/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pulls?state=open&per_page=${PR_LIST_CAP}&sort=updated&direction=desc`,
    token,
  );
  if (!ok) {
    return { items: [], error: `GitHub ${status}: ${data?.message ?? "list PRs failed"}` };
  }
  if (!Array.isArray(data) || data.length === 0) return { items: [] };

  const items: MergeableRow[] = [];
  for (const pr of data) {
    if (detailBudget.left <= 0) break;
    const author = String(pr.user?.login ?? "");
    const isAuthor = login && author.toLowerCase() === login.toLowerCase();
    // Author path already covered by search; only pull non-author PRs when we can merge
    if (isAuthor) continue;
    if (!canMerge) continue;
    detailBudget.left -= 1;
    try {
      const row = await buildGhMergeableRow(remote, pr, token, account, login);
      if (row) items.push(row);
    } catch {
      // skip individual PR failures
    }
  }
  return { items };
}

function glProjectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

async function buildGlMergeableRow(
  remote: LocalRemote,
  mr: any,
  token: string,
): Promise<MergeableRow | null> {
  const iid = mr.iid;
  if (typeof iid !== "number") return null;

  const { ok, data: detail } = await glFetch(
    `https://${remote.host}/api/v4/projects/${glProjectPath(remote.owner, remote.repo)}/merge_requests/${iid}`,
    token,
  );
  if (!ok || !detail) return null;

  // Approvals
  let approvalsLeft = 0;
  {
    const { ok: aok, data: appr } = await glFetch(
      `https://${remote.host}/api/v4/projects/${glProjectPath(remote.owner, remote.repo)}/merge_requests/${iid}/approvals`,
      token,
    );
    if (aok && appr) {
      const required = Number(appr.approvals_required ?? 0);
      const received = Number(appr.approvals_left != null
        ? (required - (appr.approved_by?.length ?? 0))
        : appr.approvals_left ?? 0);
      // Prefer approvals_left field
      approvalsLeft =
        typeof appr.approvals_left === "number"
          ? appr.approvals_left
          : Math.max(0, required - (Array.isArray(appr.approved_by) ? appr.approved_by.length : 0));
    }
  }

  const pipe = detail.head_pipeline?.status ?? detail.pipeline?.status ?? null;
  const flags = mapGlMergeability({
    detailed_merge_status: detail.detailed_merge_status ?? detail.merge_status,
    draft: detail.draft === true || detail.work_in_progress === true,
    has_conflicts: detail.has_conflicts === true,
    approvalsLeft,
    pipelineStatus: pipe,
    divergedCommitsCount: Number(detail.diverged_commits_count ?? 0),
  });

  // User can merge?
  const userCanMerge = detail.user?.can_merge === true || detail.user?.can_merge === undefined;
  if (detail.user?.can_merge === false) return null;

  const allowedMethods: MergeMethod[] = ["merge", "squash", "rebase"];
  const title = String(detail.title ?? mr.title ?? "");

  return {
    id: `gl:${remote.host}:${remote.owner}/${remote.repo}!${iid}`,
    host: remote.host,
    hostType: "gitlab",
    owner: remote.owner,
    repo: remote.repo,
    number: iid,
    title,
    htmlUrl: String(detail.web_url ?? mr.web_url),
    account: null,
    author: String(detail.author?.username ?? mr.author?.username ?? ""),
    ready: isReady(flags) && userCanMerge,
    reasons: userCanMerge ? reasonsNotReady(flags) : ["no merge permission", ...reasonsNotReady(flags)],
    mergeableState: String(detail.detailed_merge_status ?? detail.merge_status ?? ""),
    checksClean: flags.checksClean,
    approved: flags.approved,
    notBehind: flags.notBehind,
    allowedMethods,
    defaultMethod: "merge",
    deleteBranchDefault: detail.force_remove_source_branch === true || detail.should_remove_source_branch === true,
    commitTitleDefault: title,
    commitMessageDefault: String(detail.description ?? "").slice(0, 2000),
  };
}

async function fetchGlRepoMergeable(
  remote: LocalRemote,
  token: string,
): Promise<{ items: MergeableRow[]; error?: string }> {
  const { ok, status, data } = await glFetch(
    `https://${remote.host}/api/v4/projects/${glProjectPath(remote.owner, remote.repo)}/merge_requests?state=opened&per_page=${PR_LIST_CAP}&order_by=updated_at&sort=desc`,
    token,
  );
  if (!ok) {
    return { items: [], error: `GitLab ${status}: ${data?.message ?? "list MRs failed"}` };
  }
  if (!Array.isArray(data)) return { items: [] };
  const items: MergeableRow[] = [];
  for (const mr of data) {
    try {
      const row = await buildGlMergeableRow(remote, mr, token);
      if (row) items.push(row);
    } catch {
      // skip
    }
  }
  return { items };
}

async function loadMergeable(
  config: Config,
): Promise<{ items: MergeableRow[]; failures: MergeableFailure[] }> {
  const remotes = await discoverLocalRemotes(config.scanPaths, config.ignoredRepos);
  const failures: MergeableFailure[] = [];
  const items: MergeableRow[] = [];
  const accounts = await getGhAccounts().catch(() => [] as string[]);
  const detailBudget = { left: DETAIL_CAP };

  const localKeys = new Map<string, LocalRemote>();
  for (const r of remotes) localKeys.set(remoteKey(r.owner, r.repo), r);

  const ghRemotes = remotes.filter((r) => r.hostType === "github");
  const glRemotes = remotes.filter((r) => r.hostType === "gitlab");

  // Per-account: author PRs via search (fast), then optional non-author on writeable remotes
  const accountsToQuery =
    accounts.length > 0
      ? accounts
      : config.github.defaultAccount
        ? [config.github.defaultAccount]
        : [];

  for (const account of accountsToQuery) {
    try {
      const token = await getGhToken(account);
      const login = await ghWhoAmI(token);
      const authorRes = await fetchGhAuthorMergeable(
        token,
        account,
        login,
        localKeys,
        detailBudget,
      );
      if (authorRes.error) {
        failures.push({ host: "github.com", message: `${account}: ${authorRes.error}` });
      }
      items.push(...authorRes.items);

      // Non-author mergeable: only remotes likely writable (owner == login or ownerAccounts map)
      const candidateRemotes = ghRemotes.filter((r) => {
        if (login && r.owner.toLowerCase() === login.toLowerCase()) return true;
        const mapped = config.github.ownerAccounts[r.owner.toLowerCase()];
        return mapped === account;
      }).slice(0, 20);
      await pMap(
        candidateRemotes,
        async (remote) => {
          if (detailBudget.left <= 0) return;
          const res = await fetchGhRepoMergeable(
            remote,
            token,
            account,
            login,
            true,
            detailBudget,
          );
          if (res.error) {
            failures.push({
              host: remote.host,
              remote: `${remote.owner}/${remote.repo}`,
              message: res.error,
            });
          }
          items.push(...res.items);
        },
        FETCH_CONCURRENCY,
      );
    } catch (e: any) {
      failures.push({
        host: "github.com",
        message: `${account}: ${e?.message ?? "auth failed"}`,
      });
    }
  }

  const glResults = await pMap(
    glRemotes,
    async (remote) => {
      const token = config.gitlab.tokens[remote.host];
      if (!token) {
        return {
          remote,
          items: [] as MergeableRow[],
          error: `No GitLab token for ${remote.host}`,
        };
      }
      return { remote, ...(await fetchGlRepoMergeable(remote, token)) };
    },
    FETCH_CONCURRENCY,
  );

  for (const res of glResults) {
    if (res.error) {
      failures.push({
        host: res.remote.host,
        remote: `${res.remote.owner}/${res.remote.repo}`,
        message: res.error,
      });
    }
    items.push(...res.items);
  }

  // Dedupe by id
  const byId = new Map<string, MergeableRow>();
  for (const it of items) {
    if (!byId.has(it.id)) byId.set(it.id, it);
  }
  const deduped = [...byId.values()];

  // Ready first, then by title
  deduped.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return { items: deduped, failures };
}

export async function getMergeable(
  config: Config,
  opts: { force?: boolean } = {},
): Promise<MergeableResult> {
  const now = Date.now();
  let bag = cache;
  let cached = false;
  if (!opts.force && bag && now - bag.storedAt < CACHE_TTL_MS) {
    cached = true;
  } else {
    const loaded = await loadMergeable(config);
    bag = { items: loaded.items, failures: loaded.failures, storedAt: now };
    cache = bag;
  }
  return {
    items: bag!.items,
    generatedAt: new Date(bag!.storedAt).toISOString(),
    cached,
    failures: bag!.failures,
  };
}

/** Live uncached status for a single PR/MR — used by confirm modal. */
export async function getMergeableStatus(
  config: Config,
  input: {
    hostType: "github" | "gitlab";
    host: string;
    owner: string;
    repo: string;
    number: number;
    account?: string;
  },
): Promise<MergeableRow | null> {
  if (input.hostType === "github") {
    const accounts = await getGhAccounts().catch(() => [] as string[]);
    const account =
      input.account ?? resolveGithubAccount(input.owner, config, accounts);
    const token = await getGhToken(account);
    const remote: LocalRemote = {
      name: `${input.owner}/${input.repo}`,
      path: "",
      remoteUrl: "",
      host: input.host || "github.com",
      owner: input.owner,
      repo: input.repo,
      hostType: "github",
    };
    const { ok, data: pr } = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}`,
      token,
    );
    if (!ok || !pr) return null;
    return buildGhMergeableRow(remote, pr, token, account ?? null, await ghWhoAmI(token));
  }

  const token = config.gitlab.tokens[input.host];
  if (!token) return null;
  const remote: LocalRemote = {
    name: `${input.owner}/${input.repo}`,
    path: "",
    remoteUrl: "",
    host: input.host,
    owner: input.owner,
    repo: input.repo,
    hostType: "gitlab",
  };
  const { ok, data: mr } = await glFetch(
    `https://${input.host}/api/v4/projects/${glProjectPath(input.owner, input.repo)}/merge_requests/${input.number}`,
    token,
  );
  if (!ok || !mr) return null;
  return buildGlMergeableRow(remote, mr, token);
}

export async function mergePullRequest(
  config: Config,
  input: MergeInput,
): Promise<{ ok: boolean; message?: string; htmlUrl?: string }> {
  // Always re-validate ready
  const status = await getMergeableStatus(config, input);
  if (!status) {
    return { ok: false, message: "Could not load PR/MR status" };
  }
  if (!status.ready) {
    return {
      ok: false,
      message: `Not ready to merge: ${status.reasons.join(", ") || "unknown"}`,
    };
  }
  if (!status.allowedMethods.includes(input.method)) {
    return { ok: false, message: `Merge method "${input.method}" not allowed on this repo` };
  }

  if (input.hostType === "github") {
    const accounts = await getGhAccounts().catch(() => [] as string[]);
    const account =
      input.account ?? resolveGithubAccount(input.owner, config, accounts);
    const token = await getGhToken(account);
    const body: Record<string, string> = {
      merge_method: input.method,
    };
    if (input.commitTitle) body.commit_title = input.commitTitle;
    if (input.commitMessage) body.commit_message = input.commitMessage;

    const { ok, status: httpStatus, data } = await ghFetch(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}/merge`,
      token,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!ok) {
      return {
        ok: false,
        message: `GitHub ${httpStatus}: ${data?.message ?? "merge failed"}`,
      };
    }
    clearMergeableCache();
    return {
      ok: true,
      message: data?.message ?? "Merged",
      htmlUrl: status.htmlUrl,
    };
  }

  const token = config.gitlab.tokens[input.host];
  if (!token) return { ok: false, message: `No GitLab token for ${input.host}` };

  const glMethod =
    input.method === "squash"
      ? { squash: true }
      : input.method === "rebase"
        ? { merge_when_pipeline_succeeds: false }
        : {};

  const body: Record<string, unknown> = {
    should_remove_source_branch: status.deleteBranchDefault,
    ...glMethod,
  };
  if (input.method === "squash") {
    body.squash = true;
    if (input.commitTitle) body.squash_commit_message = input.commitTitle;
  }
  if (input.commitMessage) body.merge_commit_message = input.commitMessage;

  const { ok, status: httpStatus, data } = await glFetch(
    `https://${input.host}/api/v4/projects/${glProjectPath(input.owner, input.repo)}/merge_requests/${input.number}/merge`,
    token,
    { method: "PUT", body: JSON.stringify(body) },
  );
  if (!ok) {
    return {
      ok: false,
      message: `GitLab ${httpStatus}: ${data?.message ?? JSON.stringify(data) ?? "merge failed"}`,
    };
  }
  clearMergeableCache();
  return { ok: true, message: "Merged", htmlUrl: status.htmlUrl };
}
