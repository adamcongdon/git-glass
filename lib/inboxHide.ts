/**
 * lib/inboxHide.ts
 *
 * Hard-hide repos from Inbox attention (Notifications / Work / Mergeable / All local).
 * Identity: host + owner + repo. Independent of Repos ignoredRepos.
 * Intentional single-repo focus (This repo / repo dropdown) bypasses hide.
 */

export interface HiddenRepo {
  host: string;
  owner: string;
  repo: string;
}

/** Normalize host for comparison (no scheme, no trailing slash, lowercased). */
export function normalizeHiddenHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

export function normalizeHiddenPart(s: string): string {
  return s.trim().toLowerCase();
}

/** Stable comparison key: host|owner|repo (all lowercased). */
export function hiddenRepoKey(host: string, owner: string, repo: string): string {
  return `${normalizeHiddenHost(host)}|${normalizeHiddenPart(owner)}|${normalizeHiddenPart(repo)}`;
}

/**
 * Parse "owner/repo" or "group/sub/repo" (GitLab nested groups).
 * Last path segment is the repo name.
 */
export function parseOwnerRepo(ownerRepo: string): { owner: string; repo: string } | null {
  const s = ownerRepo.trim().replace(/^\/+|\/+$/g, "");
  if (!s || !s.includes("/")) return null;
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.pop()!;
  const owner = parts.join("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function isHiddenRepo(
  hidden: readonly HiddenRepo[],
  host: string,
  owner: string,
  repo: string,
): boolean {
  if (!hidden.length) return false;
  const key = hiddenRepoKey(host, owner, repo);
  return hidden.some((h) => hiddenRepoKey(h.host, h.owner, h.repo) === key);
}

/**
 * When the user deliberately focuses one repo (This repo mode or single-repo
 * dropdown), hard-hide must not apply — they asked to see that repo.
 */
export function shouldApplyHiddenFilter(focusRepo?: string | null): boolean {
  return !focusRepo?.trim();
}

export function excludeHiddenRows<T extends { host: string; owner: string; repo: string }>(
  rows: T[],
  hidden: readonly HiddenRepo[],
  opts?: { focusRepo?: string | null },
): T[] {
  if (!hidden.length) return rows;
  if (!shouldApplyHiddenFilter(opts?.focusRepo)) return rows;
  return rows.filter((r) => !isHiddenRepo(hidden, r.host, r.owner, r.repo));
}

/** Notifications store repo as "owner/repo" (nullable), plus host. */
export function excludeHiddenNotifications<
  T extends { host: string; repo: string | null },
>(rows: T[], hidden: readonly HiddenRepo[]): T[] {
  if (!hidden.length) return rows;
  return rows.filter((r) => {
    if (!r.repo) return true;
    const parsed = parseOwnerRepo(r.repo);
    if (!parsed) return true;
    return !isHiddenRepo(hidden, r.host, parsed.owner, parsed.repo);
  });
}

/** Upsert-normalize a hide target; returns null if invalid. */
export function normalizeHiddenRepo(
  host: string,
  owner: string,
  repo: string,
): HiddenRepo | null {
  const h = normalizeHiddenHost(host);
  const o = owner.trim();
  const r = repo.trim();
  if (!h || !o || !r) return null;
  if (o.includes("..") || r.includes("..")) return null;
  return { host: h, owner: o, repo: r };
}

/** Add to list (dedupe by key). Returns new array. */
export function addHiddenRepo(
  list: readonly HiddenRepo[],
  entry: HiddenRepo,
): HiddenRepo[] {
  const key = hiddenRepoKey(entry.host, entry.owner, entry.repo);
  if (list.some((h) => hiddenRepoKey(h.host, h.owner, h.repo) === key)) {
    return [...list];
  }
  return [...list, { host: entry.host, owner: entry.owner, repo: entry.repo }];
}

/** Remove matching key. Returns new array. */
export function removeHiddenRepo(
  list: readonly HiddenRepo[],
  host: string,
  owner: string,
  repo: string,
): HiddenRepo[] {
  const key = hiddenRepoKey(host, owner, repo);
  return list.filter((h) => hiddenRepoKey(h.host, h.owner, h.repo) !== key);
}

/** Display label for drawer / options. */
export function formatHiddenRepo(h: HiddenRepo): string {
  const host = normalizeHiddenHost(h.host);
  if (host === "github.com") return `${h.owner}/${h.repo}`;
  return `${h.owner}/${h.repo} (${host})`;
}
