import { Hono } from "hono";
import { z } from "zod";
import { join, resolve as resolvePath } from "path";
import { readFile } from "fs/promises";
import { readConfig, writeConfig, redactConfig } from "./lib/config";
import { scanRepos, parseRemoteUrl } from "./lib/scanner";
import { triageFeedback } from "./lib/triage";
import { createIssue } from "./lib/github";
import { createIssue as createGitLabIssue } from "./lib/gitlab";
import { getGhAccounts, getGhToken } from "./lib/gh";
import { validateRepoPath, getAllRepoStatuses, runGit } from "./lib/gitStatus";
import { gitPull, gitPush, pullAllSafe, deleteRepo, openVSCode, revealInFinder } from "./lib/gitOps";
import { isAvailable as inferenceAvailable, run as inferenceRun } from "./lib/inference";
import { getLeaderboard } from "./lib/leaderboard";

const app = new Hono();

const PUBLIC_DIR = join(import.meta.dir, "public");

async function serveFile(path: string, contentType: string): Promise<Response> {
  try {
    const content = await readFile(path);
    return new Response(content, {
      headers: { "Content-Type": contentType },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message, status } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Origin/Referer check for mutating endpoints. The server only binds to 127.0.0.1, but a
// malicious webpage can still POST cross-origin with Content-Type: text/plain (no preflight),
// and Hono parses the JSON regardless. Returns null when the request looks same-origin (or
// has no Origin/Referer at all — assumed CLI usage).
function sameOriginGuard(c: any): Response | null {
  const isLoopbackHost = (h: string) =>
    h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  const checkUrl = (raw: string | undefined): boolean | null => {
    if (!raw) return null;
    try {
      return isLoopbackHost(new URL(raw).hostname);
    } catch {
      return false;
    }
  };
  const originOk = checkUrl(c.req.header("origin"));
  if (originOk === false) return errorResponse("CSRF_REJECTED", "Cross-origin request rejected", 403);
  if (originOk === true) return null;
  const refererOk = checkUrl(c.req.header("referer"));
  if (refererOk === false) return errorResponse("CSRF_REJECTED", "Cross-origin request rejected", 403);
  return null;
}

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

// Discovered gh accounts
app.get("/api/gh-accounts", async (c) => {
  try {
    const accounts = await getGhAccounts();
    return c.json(accounts);
  } catch (err: any) {
    return errorResponse("GH_ERROR", err.message, 500);
  }
});

// Config endpoints
app.get("/api/config", async (c) => {
  const config = await readConfig();
  return c.json(redactConfig(config));
});

// RFC 1123 hostname shape (label-by-label, ≤253 chars total). Used for GitLab host keys.
const HostnameSchema = z.string().regex(
  /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
  "must be a valid hostname",
);

const ConfigUpdateSchema = z.object({
  scanPaths: z.array(z.string().min(1)).optional(),
  scanDepth: z.number().int().min(1).max(10).optional(),
  github: z
    .object({
      copilotAccount: z.string().optional(),
      defaultAccount: z.string().optional(),
      ownerAccounts: z.record(z.string()).optional(),
    })
    .optional(),
  gitlab: z
    .object({
      // Empty-string value deletes the host entry; non-empty upserts.
      tokens: z.record(HostnameSchema, z.string().max(512)).optional(),
    })
    .optional(),
  ignoredRepos: z.array(z.string()).optional(),
  repos: z
    .object({
      autoRefreshSec: z.number().int().min(0).max(1800).optional(),
    })
    .optional(),
});

app.put("/api/config", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const parsed = ConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", parsed.error.message, 400);
  }

  try {
    const updated = await writeConfig(parsed.data);
    return c.json(redactConfig(updated));
  } catch (err: any) {
    return errorResponse("CONFIG_WRITE_ERROR", err.message, 500);
  }
});

// Repo scanner
app.get("/api/repos", async (c) => {
  const config = await readConfig();
  const repos = await scanRepos(config.scanPaths, config.scanDepth);
  return c.json(repos);
});

// Triage endpoint
const RepoCandidateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(140)
    .regex(/^[^/\s]+\/[^/\s]+$/, "must be in owner/repo format"),
  host: HostnameSchema,
});

const TriageRequestSchema = z.object({
  text: z.string().min(1).max(10000),
  imageBase64: z.string().optional(),
  imageMimeType: z.string().optional(),
  repos: z.array(RepoCandidateSchema).max(200).optional(),
});

app.post("/api/triage", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const parsed = TriageRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", parsed.error.message, 400);
  }

  const config = await readConfig();
  let triageToken: string;
  try {
    triageToken = await getGhToken(config.github.copilotAccount);
  } catch (err: any) {
    const hint = config.github.copilotAccount
      ? `Could not get token for "${config.github.copilotAccount}"`
      : "No AI account configured";
    return errorResponse(
      "NO_COPILOT_TOKEN",
      `${hint} — open Settings and select a GitHub account with Copilot access`,
      400,
    );
  }

  try {
    const result = await triageFeedback(
      parsed.data.text,
      triageToken,
      parsed.data.imageBase64,
      parsed.data.imageMimeType,
      parsed.data.repos,
    );

    // Validate suggested repo against the request's repo list (server-side guard)
    let suggestedRepo: string | null = result.suggestedRepo;
    if (suggestedRepo !== null) {
      const repoNameSet = new Set((parsed.data.repos ?? []).map((r) => r.name));
      if (!repoNameSet.has(suggestedRepo)) {
        console.log(`[triage] suggested_repo "${suggestedRepo}" not in request list — coercing to null`);
        suggestedRepo = null;
      }
    }

    return c.json({
      title: result.title,
      body: result.body,
      type: result.type,
      suggestedRepo,
    });
  } catch (err: any) {
    return errorResponse("TRIAGE_ERROR", err.message, 500);
  }
});

// Issue creation endpoint
const IssueRequestSchema = z.object({
  repoRemoteUrl: z.string().min(1),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65536),
  type: z.enum(["bug", "feature", "question"]),
  imageBase64: z.string().optional(),
});

app.post("/api/issues", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const parsed = IssueRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", parsed.error.message, 400);
  }

  const repoInfo = parseRemoteUrl(parsed.data.repoRemoteUrl);
  if (!repoInfo) {
    return errorResponse("INVALID_REMOTE_URL", "Cannot parse repository remote URL", 400);
  }

  const config = await readConfig();
  const target = `${repoInfo.host}/${repoInfo.owner}/${repoInfo.repo}`;
  const isGitHub = repoInfo.host.toLowerCase() === "github.com";

  // GitHub flow: gh token via per-owner mapping → default account
  if (isGitHub) {
    const account =
      config.github.ownerAccounts[repoInfo.owner.toLowerCase()] ??
      config.github.defaultAccount;

    let issueToken: string;
    try {
      issueToken = await getGhToken(account);
    } catch (err: any) {
      const hint = account ? `Could not get token for "${account}"` : "No GitHub account configured";
      return errorResponse(
        "NO_ISSUE_TOKEN",
        `${hint} — open Settings and select a default GitHub account`,
        400,
      );
    }

    console.log(`[issues] POST ${target} via github account="${account ?? "(active)"}"`);
    try {
      const result = await createIssue(
        repoInfo.owner,
        repoInfo.repo,
        issueToken,
        {
          title: parsed.data.title,
          body: parsed.data.body,
          type: parsed.data.type,
        },
        parsed.data.imageBase64,
      );
      return c.json(result);
    } catch (err: any) {
      const status = err.status ?? 500;
      const code = err.code ?? "GITHUB_ERROR";
      const context = ` (target: ${target}, account: ${account ?? "(active)"})`;
      console.error(`[issues] ${status} ${code}${context}: ${err.message}`);
      return errorResponse(code, `${err.message}${context}`, status);
    }
  }

  // GitLab flow: per-host PAT from config
  const token = config.gitlab.tokens[repoInfo.host];
  if (!token) {
    return errorResponse(
      "NO_GITLAB_TOKEN",
      `No GitLab token configured for ${repoInfo.host} — open Settings → GitLab Tokens and add a Personal Access Token with "api" scope`,
      400,
    );
  }

  console.log(`[issues] POST ${target} via gitlab token`);
  try {
    const result = await createGitLabIssue(
      repoInfo.host,
      repoInfo.owner,
      repoInfo.repo,
      token,
      {
        title: parsed.data.title,
        body: parsed.data.body,
        type: parsed.data.type,
      },
      parsed.data.imageBase64,
    );
    return c.json(result);
  } catch (err: any) {
    const status = err.status ?? 500;
    const code = err.code ?? "GITLAB_ERROR";
    const context = ` (target: ${target})`;
    console.error(`[issues] ${status} ${code}${context}: ${err.message}`);
    return errorResponse(code, `${err.message}${context}`, status);
  }
});

// ─── Git Repos routes ─────────────────────────────────────────────────────────

// GET /api/git/repos — scan + status for all non-ignored repos
app.get("/api/git/repos", async (c) => {
  try {
    const config = await readConfig();
    const statuses = await getAllRepoStatuses(config.scanPaths, config.ignoredRepos);
    return c.json(statuses);
  } catch (err: any) {
    return errorResponse("GIT_REPOS_ERROR", err.message, 500);
  }
});

// GET /api/leaderboard — ranked repo activity leaderboard
const LeaderboardWindowSchema = z.enum(["7d", "30d", "90d", "all"]).optional().default("30d");

app.get("/api/leaderboard", async (c) => {
  const raw = c.req.query("window");
  const parsed = LeaderboardWindowSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", parsed.error.message, 400);
  }
  try {
    const config = await readConfig();
    const data = await getLeaderboard(config, parsed.data);
    return c.json(data);
  } catch (err: any) {
    return errorResponse("LEADERBOARD_ERROR", err.message, 500);
  }
});

// GET /api/git/ignored — list ignored repo paths
app.get("/api/git/ignored", async (c) => {
  const config = await readConfig();
  return c.json({ ignoredRepos: config.ignoredRepos });
});

// POST /api/git/ignore — add path to ignoredRepos
app.post("/api/git/ignore", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  if (!path || typeof path !== "string") {
    return errorResponse("INVALID_PATH", "path is required", 400);
  }

  const config = await readConfig();
  const resolved = resolvePath(path);
  const existing = new Set(config.ignoredRepos.map((p) => resolvePath(p)));
  if (!existing.has(resolved)) {
    existing.add(resolved);
    await writeConfig({ ignoredRepos: Array.from(existing) });
  }
  const updated = await readConfig();
  return c.json({ ok: true, ignoredRepos: updated.ignoredRepos });
});

// POST /api/git/unignore — remove path from ignoredRepos
app.post("/api/git/unignore", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  if (!path || typeof path !== "string") {
    return errorResponse("INVALID_PATH", "path is required", 400);
  }

  const config = await readConfig();
  const resolved = resolvePath(path);
  const filtered = config.ignoredRepos.filter((p) => resolvePath(p) !== resolved);
  await writeConfig({ ignoredRepos: filtered });
  const updated = await readConfig();
  return c.json({ ok: true, ignoredRepos: updated.ignoredRepos });
});

// POST /api/git/pull — git pull one repo
app.post("/api/git/pull", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  const config = await readConfig();
  const result = await gitPull(path, config.scanPaths);
  if (!result.ok) return errorResponse("GIT_PULL_ERROR", result.error ?? "Pull failed", 400);
  return c.json({ ok: true, output: result.output });
});

// POST /api/git/push — git push one repo
app.post("/api/git/push", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  const config = await readConfig();
  const result = await gitPush(path, config.scanPaths);
  if (!result.ok) return errorResponse("GIT_PUSH_ERROR", result.error ?? "Push failed", 400);
  return c.json({ ok: true, output: result.output });
});

// POST /api/git/pull-all-safe — pull all repos with behind>0 && uncommitted=0 && !error
app.post("/api/git/pull-all-safe", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  try {
    const config = await readConfig();
    const statuses = await getAllRepoStatuses(config.scanPaths, config.ignoredRepos);
    const candidates = pullAllSafe(statuses);
    const results = await Promise.all(
      candidates.map(async (s) => {
        const result = await gitPull(s.path, config.scanPaths);
        return { repo: s.name, path: s.path, ok: result.ok, output: result.output, error: result.error };
      }),
    );
    return c.json({ ok: true, results, total: candidates.length });
  } catch (err: any) {
    return errorResponse("PULL_ALL_ERROR", err.message, 500);
  }
});

// POST /api/git/open-vscode — open repo in VS Code
app.post("/api/git/open-vscode", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  const config = await readConfig();
  const result = await openVSCode(path, config.scanPaths);
  if (!result.ok) return errorResponse("VSCODE_ERROR", result.error ?? "Failed to open VS Code", 400);
  return c.json({ ok: true });
});

// POST /api/git/reveal — reveal repo in Finder
app.post("/api/git/reveal", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  const config = await readConfig();
  const result = await revealInFinder(path, config.scanPaths);
  if (!result.ok) return errorResponse("REVEAL_ERROR", result.error ?? "Failed to reveal in Finder", 400);
  return c.json({ ok: true });
});

// POST /api/git/delete — permanently delete a repo (double-validated)
app.post("/api/git/delete", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  const config = await readConfig();

  // validateRepoPath check (inside scanPaths + no traversal)
  const v = validateRepoPath(path, config.scanPaths);
  if ("error" in v) {
    return errorResponse("INVALID_PATH", v.error, v.status);
  }

  const result = await deleteRepo(path, config.scanPaths);
  if (!result.ok) {
    return errorResponse(result.code ?? "DELETE_ERROR", result.error ?? "Delete failed", result.status ?? 500);
  }
  return c.json({ ok: true });
});

// POST /api/git/ai-commit-msg — generate commit message via Inference.ts
app.post("/api/git/ai-commit-msg", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  if (!(await inferenceAvailable())) {
    return errorResponse("AI_UNAVAILABLE", "AI inference not available (Inference.ts not found)", 503);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const { path } = body as any;
  const config = await readConfig();
  const v = validateRepoPath(path, config.scanPaths);
  if ("error" in v) return errorResponse("INVALID_PATH", v.error, v.status);

  try {
    const staged = await runGit(v.resolved, ["diff", "--staged"]);
    const diff = staged || (await runGit(v.resolved, ["diff", "HEAD"]));
    if (!diff) {
      return errorResponse("NO_DIFF", "No changes to generate message for", 400);
    }
    const maxLen = 8000;
    const truncated = diff.length > maxLen ? diff.slice(0, maxLen) + "\n\n... [diff truncated]" : diff;
    const systemPrompt =
      "You are a git commit message generator. Output ONLY the commit message, nothing else. Use conventional commit format (feat:, fix:, refactor:, docs:, chore:, etc). First line max 72 chars. Add body paragraph if the change is non-trivial.";
    const userPrompt = "Generate a commit message for this diff:\n\n" + truncated;

    const result = await inferenceRun(systemPrompt, userPrompt);
    if (result.status === "timeout") {
      return errorResponse("AI_TIMEOUT", "AI inference timed out", 504);
    }
    if (result.status === "unavailable") {
      return errorResponse("AI_UNAVAILABLE", "AI inference not available", 503);
    }
    if (result.status === "error") {
      return errorResponse("AI_ERROR", result.errorMsg ?? "AI inference error", 500);
    }
    return c.json({ ok: true, message: result.stdout });
  } catch (err: any) {
    return errorResponse("AI_COMMIT_ERROR", err.message, 500);
  }
});

// POST /api/git/ai-triage — AI triage all actionable repos
app.post("/api/git/ai-triage", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  if (!(await inferenceAvailable())) {
    return errorResponse("AI_UNAVAILABLE", "AI inference not available (Inference.ts not found)", 503);
  }

  try {
    const config = await readConfig();
    const statuses = await getAllRepoStatuses(config.scanPaths, config.ignoredRepos);
    const actionable = statuses.filter(
      (s) => s.uncommitted > 0 || s.ahead > 0 || s.behind > 0 || s.error || !s.hasRemote,
    );
    if (actionable.length === 0) {
      return c.json({ ok: true, triage: "All repos are clean — nothing needs attention!", repoCount: 0 });
    }
    const MAX_TRIAGE_REPOS = 40;
    const truncatedList = actionable.slice(0, MAX_TRIAGE_REPOS);
    const summary = JSON.stringify(
      truncatedList.map((s) => ({
        name: s.name,
        branch: s.branch,
        uncommitted: s.uncommitted,
        ahead: s.ahead,
        behind: s.behind,
        hasRemote: s.hasRemote,
        error: s.error,
        lastCommitDate: s.lastCommitDate,
      })),
    );
    const overflowNote =
      actionable.length > MAX_TRIAGE_REPOS
        ? `\n\nNote: ${actionable.length - MAX_TRIAGE_REPOS} additional actionable repos omitted from this batch.`
        : "";
    const systemPrompt =
      "You are a git repository triage assistant. Given a JSON array of repos needing attention, output a SHORT prioritized action list. Group by urgency. Use emoji prefixes: urgent (errors, conflicts), action needed (uncommitted changes, push/pull), informational (no remote, stale). Be concise — one line per repo.";
    const userPrompt = "Triage these repos:\n" + summary + overflowNote;

    const result = await inferenceRun(systemPrompt, userPrompt);
    if (result.status === "timeout") {
      return errorResponse("AI_TIMEOUT", "AI inference timed out", 504);
    }
    if (result.status === "unavailable") {
      return errorResponse("AI_UNAVAILABLE", "AI inference not available", 503);
    }
    if (result.status === "error") {
      return errorResponse("AI_ERROR", result.errorMsg ?? "AI inference error", 500);
    }
    return c.json({ ok: true, triage: result.stdout, repoCount: actionable.length });
  } catch (err: any) {
    return errorResponse("AI_TRIAGE_ERROR", err.message, 500);
  }
});

// ─── Server self-management ───────────────────────────────────────────────────

// The dashboard's own checkout directory. Captured at module load so it cannot
// be redirected by config changes or path traversal in request bodies.
const SELF_REPO_DIR = resolvePath(import.meta.dir);

// POST /api/update — run `git pull --ff-only` on the dashboard's own repo
app.post("/api/update", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  try {
    const proc = Bun.spawn(["git", "pull", "--ff-only"], {
      cwd: SELF_REPO_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    const stdoutP = new Response(proc.stdout).text();
    const stderrP = new Response(proc.stderr).text();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => { proc.kill(); reject(new Error("git pull timed out after 30s")); }, 30_000),
    );
    const [stdout, stderr] = await Promise.race([Promise.all([stdoutP, stderrP]), timeout]);
    const exitCode = await proc.exited;
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    const maxLen = 8000;
    const output = combined.length > maxLen ? combined.slice(0, maxLen) + "\n\n... [output truncated]" : combined;
    const alreadyUpToDate = /Already up to date/i.test(output);
    return c.json({ ok: exitCode === 0, output, alreadyUpToDate });
  } catch (err: any) {
    return c.json({ ok: false, output: String(err?.message ?? err), alreadyUpToDate: false }, 200);
  }
});

// POST /api/restart — schedule process.exit so launchd KeepAlive restarts the server
app.post("/api/restart", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;

  setTimeout(() => process.exit(0), 300);
  return c.json({ ok: true, message: "Server restarting..." });
});

// ─── Static file routes ───────────────────────────────────────────────────────

// Static file routes
app.get("/manifest.json", () => serveFile(join(PUBLIC_DIR, "manifest.json"), "application/manifest+json"));
app.get("/sw.js", () => serveFile(join(PUBLIC_DIR, "sw.js"), "application/javascript"));
app.get("/icons/:file", (c) => {
  const file = c.req.param("file");
  if (!/^[\w\-\.]+\.png$/.test(file)) {
    return new Response("Not found", { status: 404 });
  }
  return serveFile(join(PUBLIC_DIR, "icons", file), "image/png");
});

// All other routes serve app.html
app.get("*", () => serveFile(join(PUBLIC_DIR, "app.html"), "text/html"));

// Start server
const config = await readConfig();
const PORT = config.port ?? 7777;

let server;
try {
  server = Bun.serve({
    fetch: app.fetch,
    port: PORT,
    hostname: "127.0.0.1",
    error(_error: Error) {
      return new Response("Internal Server Error", { status: 500 });
    },
  });
} catch (err: any) {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Run: kill $(lsof -ti :${PORT})`);
    process.exit(1);
  }
  throw err;
}

console.log(`Feedback Tool running at http://127.0.0.1:${PORT}`);
