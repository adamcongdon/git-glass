import { rm, lstat } from "fs/promises";
import { join } from "path";
import { validateRepoPath, runGit } from "./gitStatus";
import type { RepoStatus } from "./gitStatus";

export type GitOpCode =
  | "OK"
  | "INVALID_PATH"
  | "NOT_A_REPO"
  | "NOT_A_DIRECTORY"
  | "RUN_FAILED";

export interface GitOpResult {
  ok: boolean;
  output?: string;
  error?: string;
  code?: GitOpCode;
  status?: number;
}

// ─── gitPull ──────────────────────────────────────────────────────────────────

export async function gitPull(
  path: string,
  scanPaths: string[],
): Promise<GitOpResult> {
  const v = validateRepoPath(path, scanPaths);
  if ("error" in v) return { ok: false, error: v.error, code: "INVALID_PATH", status: v.status };
  try {
    const output = await runGit(v.resolved, ["pull"]);
    return { ok: true, output, code: "OK" };
  } catch (e: any) {
    return { ok: false, error: e.message, code: "RUN_FAILED", status: 500 };
  }
}

// ─── gitPush ──────────────────────────────────────────────────────────────────

export async function gitPush(
  path: string,
  scanPaths: string[],
): Promise<GitOpResult> {
  const v = validateRepoPath(path, scanPaths);
  if ("error" in v) return { ok: false, error: v.error, code: "INVALID_PATH", status: v.status };
  try {
    const output = await runGit(v.resolved, ["push"]);
    return { ok: true, output, code: "OK" };
  } catch (e: any) {
    return { ok: false, error: e.message, code: "RUN_FAILED", status: 500 };
  }
}

// ─── pullAllSafe ─────────────────────────────────────────────────────────────

/**
 * Filter predicate for safe-to-pull repos.
 * A repo is safe to pull if: behind > 0, uncommitted === 0, no error.
 * This is a pure function — the actual pull calls happen separately.
 */
export function pullAllSafe(
  statuses: Pick<RepoStatus, "name" | "path" | "behind" | "uncommitted" | "error">[],
): typeof statuses {
  return statuses.filter(
    (s) => s.behind > 0 && s.uncommitted === 0 && !s.error,
  );
}

// ─── deleteRepo ──────────────────────────────────────────────────────────────

// Gates:
//   1. validateRepoPath — realpath'd, no traversal, inside scanPaths
//   2. lstat resolved → must be a real directory (not a symlink swapped after validation)
//   3. lstat .git → must be a directory (rules out submodule .git files; matches dashboard semantics)
export async function deleteRepo(
  path: string,
  scanPaths: string[],
): Promise<GitOpResult> {
  const v = validateRepoPath(path, scanPaths);
  if ("error" in v) return { ok: false, error: v.error, code: "INVALID_PATH", status: v.status };

  try {
    const lst = await lstat(v.resolved);
    if (!lst.isDirectory()) {
      return { ok: false, error: `Path is not a directory: ${v.resolved}`, code: "NOT_A_DIRECTORY", status: 400 };
    }
  } catch (e: any) {
    return { ok: false, error: `Path does not exist: ${v.resolved}`, code: "NOT_A_REPO", status: 400 };
  }

  const gitDir = join(v.resolved, ".git");
  try {
    const gst = await lstat(gitDir);
    if (!gst.isDirectory()) {
      return { ok: false, error: `Safety check failed: .git at ${v.resolved} is not a directory`, code: "NOT_A_REPO", status: 400 };
    }
  } catch {
    return { ok: false, error: `Safety check failed: no .git/ at ${v.resolved}`, code: "NOT_A_REPO", status: 400 };
  }

  try {
    await rm(v.resolved, { recursive: true, force: true });
    return { ok: true, code: "OK" };
  } catch (e: any) {
    return { ok: false, error: e.message, code: "RUN_FAILED", status: 500 };
  }
}

// ─── openVSCode ───────────────────────────────────────────────────────────────

export async function openVSCode(
  path: string,
  scanPaths: string[],
): Promise<GitOpResult> {
  const v = validateRepoPath(path, scanPaths);
  if ("error" in v) return { ok: false, error: v.error, code: "INVALID_PATH", status: v.status };
  try {
    const proc = Bun.spawn(["code", v.resolved], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return { ok: true, code: "OK" };
  } catch (e: any) {
    return { ok: false, error: e.message, code: "RUN_FAILED", status: 500 };
  }
}

// ─── revealInFinder ───────────────────────────────────────────────────────────

export async function revealInFinder(
  path: string,
  scanPaths: string[],
): Promise<GitOpResult> {
  const v = validateRepoPath(path, scanPaths);
  if ("error" in v) return { ok: false, error: v.error, code: "INVALID_PATH", status: v.status };
  try {
    const cmd =
      process.platform === "win32"
        ? ["explorer", `/select,${v.resolved}`]
        : ["open", "-R", v.resolved];
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return { ok: true, code: "OK" };
  } catch (e: any) {
    return { ok: false, error: e.message, code: "RUN_FAILED", status: 500 };
  }
}
