import { z } from "zod";

// Jira targets file feedback by opening Jira's own "Create issue" form with the
// fields prefilled as query params (CreateIssueDetails!init.jspa). No API token is
// involved: the user reviews the form in their logged-in browser and clicks Create.
// Every site-specific value (host, project, issue type, epic, labels) lives in the
// local config, never in code.

export const JiraTargetSchema = z.object({
  /** Display name in the Feedback repo picker. Unique per config. */
  name: z.string().min(1).max(64),
  /** Site root, e.g. https://your-site.atlassian.net */
  baseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "must be an https:// URL"),
  /** Numeric project id (the `pid` param), not the project key. */
  projectId: z.string().regex(/^\d+$/, "must be a numeric project id"),
  /** Numeric issue type id (the `issuetype` param). */
  issueTypeId: z.string().regex(/^\d+$/, "must be a numeric issue type id"),
  /** Optional parent epic key, e.g. ABC-123. */
  epicKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/, "must look like ABC-123").optional(),
  /** Custom field that holds the epic link on this site. */
  epicField: z.string().regex(/^customfield_\d+$/).default("customfield_10014"),
  /** Jira labels cannot contain spaces. */
  labels: z.array(z.string().regex(/^\S{1,255}$/, "labels cannot contain spaces")).default([]),
});

export type JiraTarget = z.infer<typeof JiraTargetSchema>;

/** Atlassian's edge rejects much longer request lines. */
export const JIRA_MAX_URL = 8000;

const TRUNCATION_NOTE = "\n\n…(truncated, full text is on your clipboard)";

export function buildJiraCreateUrl(target: JiraTarget, title: string, description: string): string {
  const fields: [string, string][] = [];
  if (target.epicKey) fields.push([target.epicField, target.epicKey]);
  fields.push(["description", description], ["issuetype", target.issueTypeId]);
  for (const label of target.labels) fields.push(["labels", label]);
  fields.push(["pid", target.projectId], ["summary", title]);

  const base = `${target.baseUrl.replace(/\/+$/, "")}/secure/CreateIssueDetails!init.jspa`;
  // encodeURIComponent (%20 for spaces) — Jira's form reads it the same as `+`.
  return `${base}?${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/**
 * Builds the link, trimming the description until the URL fits `maxLength`.
 * Callers should hand the full description to the user another way (clipboard)
 * when `truncated` is true.
 */
export function fitJiraCreateUrl(
  target: JiraTarget,
  title: string,
  description: string,
  maxLength = JIRA_MAX_URL,
): { url: string; truncated: boolean } {
  const full = buildJiraCreateUrl(target, title, description);
  if (full.length <= maxLength) return { url: full, truncated: false };

  // Never cut between a surrogate pair: encodeURIComponent throws on a lone half.
  const prefix = (n: number) => {
    const code = description.charCodeAt(n - 1);
    return description.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
  };

  // Binary search the longest description prefix that still fits.
  let lo = 0;
  let hi = description.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const url = buildJiraCreateUrl(target, title, prefix(mid) + TRUNCATION_NOTE);
    if (url.length <= maxLength) lo = mid;
    else hi = mid - 1;
  }
  const url = buildJiraCreateUrl(target, title, prefix(lo) + TRUNCATION_NOTE);
  if (url.length > maxLength) throw new Error("Title is too long to fit in a Jira link");
  return { url, truncated: true };
}
