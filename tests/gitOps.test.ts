import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { deleteRepo, pullAllSafe } from "../lib/gitOps";

// ─── deleteRepo safety ───────────────────────────────────────────────────────

describe("deleteRepo", () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = join(tmpdir(), `gitops-test-${Date.now()}`);
    await mkdir(tmpBase, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  test("refuses a path that exists but has no .git/ directory", async () => {
    const noGit = join(tmpBase, "not-a-repo");
    await mkdir(noGit, { recursive: true });
    const result = await deleteRepo(noGit, [tmpBase]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/\.git/i);
  });

  test("refuses a path that is outside all scanPaths entries", async () => {
    // Create a valid-looking git repo but in /tmp, not in scanPaths
    const outsideRepo = join(tmpdir(), `outside-repo-${Date.now()}`);
    await mkdir(join(outsideRepo, ".git"), { recursive: true });
    try {
      const result = await deleteRepo(outsideRepo, [tmpBase]);
      expect(result.ok).toBe(false);
    } finally {
      await rm(outsideRepo, { recursive: true, force: true });
    }
  });

  test("refuses path containing '..'", async () => {
    const result = await deleteRepo(join(tmpBase, "..", "etc"), [tmpBase]);
    expect(result.ok).toBe(false);
  });

  test("deletes a valid repo inside scanPaths that has .git/", async () => {
    const validRepo = join(tmpBase, "my-repo");
    await mkdir(join(validRepo, ".git"), { recursive: true });

    const result = await deleteRepo(validRepo, [tmpBase]);
    expect(result.ok).toBe(true);

    // Verify it was actually deleted
    let exists = true;
    try {
      await rm(validRepo);
    } catch (e: any) {
      if (e.code === "ENOENT") exists = false;
    }
    // If it was deleted, ENOENT is expected
    // The repo should not exist
    const { stat } = await import("fs/promises");
    let statErr = null;
    try { await stat(validRepo); } catch (e) { statErr = e; }
    expect(statErr).not.toBeNull();
  });
});

// ─── pullAllSafe ─────────────────────────────────────────────────────────────

describe("pullAllSafe", () => {
  test("filters to repos with behind > 0 && uncommitted === 0 && !error", () => {
    const repos = [
      // Should be included: behind > 0, uncommitted = 0, no error
      { name: "repo-a", path: "/code/repo-a", behind: 1, uncommitted: 0, error: undefined },
      // Should be excluded: has uncommitted changes
      { name: "repo-b", path: "/code/repo-b", behind: 2, uncommitted: 3, error: undefined },
      // Should be excluded: has error
      { name: "repo-c", path: "/code/repo-c", behind: 1, uncommitted: 0, error: "fatal: not a git repo" },
      // Should be excluded: not behind
      { name: "repo-d", path: "/code/repo-d", behind: 0, uncommitted: 0, error: undefined },
      // Should be included: behind > 0, clean, no error
      { name: "repo-e", path: "/code/repo-e", behind: 3, uncommitted: 0, error: undefined },
    ];

    const candidates = pullAllSafe(repos as any);
    const names = candidates.map((r) => r.name);
    expect(names).toContain("repo-a");
    expect(names).toContain("repo-e");
    expect(names).not.toContain("repo-b");
    expect(names).not.toContain("repo-c");
    expect(names).not.toContain("repo-d");
  });

  test("returns empty array when no repos qualify", () => {
    const repos = [
      { name: "clean", path: "/code/clean", behind: 0, uncommitted: 0, error: undefined },
      { name: "dirty", path: "/code/dirty", behind: 1, uncommitted: 2, error: undefined },
    ];
    expect(pullAllSafe(repos as any)).toHaveLength(0);
  });
});
