/**
 * lib/inference.ts
 *
 * Wrapper for ~/.claude/PAI/Tools/Inference.ts.
 * Used for AI commit messages and AI triage in the Repos view.
 *
 * Caller semantics:
 *   - 503 when isAvailable() returns false (file missing)
 *   - 504 when run() returns status 'timeout'
 *   - 500 when run() returns status 'error'
 *   - 200 when run() returns status 'ok'
 */

import { access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const INFERENCE_PATH = join(homedir(), ".claude", "PAI", "Tools", "Inference.ts");
const TIMEOUT_MS = 30_000;

/**
 * Check whether the PAI Inference.ts script is installed.
 * Performs a fresh stat() each call (cheap) so users can install PAI
 * later without a server restart.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    await access(INFERENCE_PATH);
    return true;
  } catch {
    return false;
  }
}

export type InferenceStatus = "ok" | "unavailable" | "timeout" | "error";

export interface InferenceResult {
  stdout: string;
  status: InferenceStatus;
  errorMsg?: string;
}

/**
 * Shell out to Inference.ts with a 30-second timeout.
 *
 * Returns:
 *   { status: 'unavailable' } when Inference.ts is not found
 *   { status: 'timeout' }     when the subprocess exceeds 30s
 *   { status: 'error', errorMsg } when the subprocess exits with non-zero / empty output
 *   { status: 'ok', stdout }  on success
 */
export async function run(
  systemPrompt: string,
  userPrompt: string,
  level: string = "fast",
): Promise<InferenceResult> {
  if (!(await isAvailable())) {
    return { stdout: "", status: "unavailable" };
  }

  // Ensure Claude CLI is discoverable even when the server was launched from a
  // restricted PATH (e.g., a launchd plist with minimal environment).
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!env.PATH?.includes("/opt/homebrew/bin")) {
    env.PATH = `${env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;
  }

  const proc = Bun.spawn(
    ["bun", INFERENCE_PATH, "--level", level, systemPrompt, userPrompt],
    {
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );

  let timedOut = false;
  let sigkillHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGTERM"); } catch {}
    sigkillHandle = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2_000);
  }, TIMEOUT_MS);

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  await proc.exited;
  clearTimeout(timeoutHandle);
  if (sigkillHandle) clearTimeout(sigkillHandle);

  if (timedOut) {
    return {
      stdout: "",
      status: "timeout",
      errorMsg: `AI inference timed out after ${TIMEOUT_MS / 1000}s`,
    };
  }

  const stdout = (await stdoutPromise).trim();
  const stderr = (await stderrPromise).trim();

  if (!stdout) {
    return {
      stdout: "",
      status: "error",
      errorMsg: stderr || "Empty response from AI inference",
    };
  }

  return { stdout, status: "ok" };
}
