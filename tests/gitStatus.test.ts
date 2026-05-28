import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Import the functions we're testing
import {
  parseAheadBehind,
  parseBranchRefs,
  validateRepoPath,
  getGitRepos,
  pMap,
} from "../lib/gitStatus";

// ─── parseAheadBehind ───────────────────────────────────────────────────────

describe("parseAheadBehind", () => {
  test("parses '1\\t2' as { ahead: 1, behind: 2 }", () => {
    expect(parseAheadBehind("1\t2")).toEqual({ ahead: 1, behind: 2 });
  });

  test("parses '0\\t0' as zeros", () => {
    expect(parseAheadBehind("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });

  test("empty string returns zeros", () => {
    expect(parseAheadBehind("")).toEqual({ ahead: 0, behind: 0 });
  });

  test("malformed string returns zeros", () => {
    expect(parseAheadBehind("garbage")).toEqual({ ahead: 0, behind: 0 });
  });

  test("non-numeric returns zeros", () => {
    expect(parseAheadBehind("abc\tdef")).toEqual({ ahead: 0, behind: 0 });
  });

  test("single number (missing tab) returns zeros", () => {
    expect(parseAheadBehind("5")).toEqual({ ahead: 0, behind: 0 });
  });
});

// ─── parseBranchRefs ────────────────────────────────────────────────────────

describe("parseBranchRefs", () => {
  test("parses standard ahead/behind tracking line", () => {
    const lines = "main|origin/main|[ahead 1, behind 2]";
    const result = parseBranchRefs(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      gone: false,
    });
  });

  test("parses [gone] upstream", () => {
    const lines = "feature|origin/feature|[gone]";
    const result = parseBranchRefs(lines);
    expect(result).toHaveLength(1);
    expect(result[0].gone).toBe(true);
    expect(result[0].name).toBe("feature");
  });

  test("handles blank lines without crashing", () => {
    const lines = "main|origin/main|\n\nfeat|origin/feat|[ahead 3]";
    const result = parseBranchRefs(lines);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("handles garbage lines without crashing", () => {
    const lines = "not|a|valid|line|with|extra|pipes";
    expect(() => parseBranchRefs(lines)).not.toThrow();
  });

  test("parses ahead-only line", () => {
    const lines = "main|origin/main|[ahead 3]";
    const result = parseBranchRefs(lines);
    expect(result[0].ahead).toBe(3);
    expect(result[0].behind).toBe(0);
  });

  test("parses behind-only line", () => {
    const lines = "main|origin/main|[behind 2]";
    const result = parseBranchRefs(lines);
    expect(result[0].ahead).toBe(0);
    expect(result[0].behind).toBe(2);
  });

  test("handles branch with no upstream (empty upstream field)", () => {
    const lines = "local-only||";
    const result = parseBranchRefs(lines);
    expect(result[0]).toMatchObject({ name: "local-only", upstream: "", gone: false, ahead: 0, behind: 0 });
  });
});

// ─── validateRepoPath ───────────────────────────────────────────────────────

describe("validateRepoPath", () => {
  const scanPaths = ["/Users/user/code"];

  test("rejects path containing '..'", () => {
    const result = validateRepoPath("/Users/user/code/../etc/passwd", scanPaths);
    expect(result).toHaveProperty("error");
  });

  test("rejects path outside scanPaths", () => {
    const result = validateRepoPath("/tmp/evil-repo", scanPaths);
    expect(result).toHaveProperty("error");
  });

  test("accepts path inside scanPaths", () => {
    const result = validateRepoPath("/Users/user/code/my-project", scanPaths);
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      expect(result.resolved).toBe("/Users/user/code/my-project");
    }
  });

  test("rejects null/undefined/non-string", () => {
    expect(validateRepoPath(null as any, scanPaths)).toHaveProperty("error");
    expect(validateRepoPath(undefined as any, scanPaths)).toHaveProperty("error");
    expect(validateRepoPath(42 as any, scanPaths)).toHaveProperty("error");
  });

  test("rejects the scanPaths root itself (must be inside, not equal)", () => {
    // The scanPath itself is the parent dir, not a valid repo location
    const result = validateRepoPath("/Users/user/code", scanPaths);
    expect(result).toHaveProperty("error");
  });

  test("rejects empty string", () => {
    expect(validateRepoPath("", scanPaths)).toHaveProperty("error");
  });
});

// ─── getGitRepos ────────────────────────────────────────────────────────────

describe("getGitRepos", () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = join(tmpdir(), `gitrepos-test-${Date.now()}`);
    await mkdir(tmpBase, { recursive: true });

    // Create a fake git repo
    await mkdir(join(tmpBase, "repo-a", ".git"), { recursive: true });
    // Create a fake git repo that will be ignored
    await mkdir(join(tmpBase, "repo-b", ".git"), { recursive: true });
    // Create a non-repo folder
    await mkdir(join(tmpBase, "not-a-repo"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  test("finds repos in scanPaths", async () => {
    const repos = await getGitRepos([tmpBase], []);
    const names = repos.map((r) => r.name);
    expect(names).toContain("repo-a");
    expect(names).toContain("repo-b");
    expect(names).not.toContain("not-a-repo");
  });

  test("excludes paths in ignoredRepos (after resolution)", async () => {
    const ignoredPath = join(tmpBase, "repo-b");
    const repos = await getGitRepos([tmpBase], [ignoredPath]);
    const names = repos.map((r) => r.name);
    expect(names).toContain("repo-a");
    expect(names).not.toContain("repo-b");
  });

  test("returns repos sorted alphabetically", async () => {
    const repos = await getGitRepos([tmpBase], []);
    const names = repos.map((r) => r.name);
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual(sorted);
  });
});

// ─── pMap ───────────────────────────────────────────────────────────────────

describe("pMap", () => {
  test("completes all 5 items with concurrency 2", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await pMap(items, async (x) => x * 2, 2);
    expect(results).toHaveLength(5);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  test("preserves input order in results", async () => {
    const items = [10, 20, 30, 40, 50];
    // Add artificial stagger to ensure ordering isn't by completion time
    const results = await pMap(
      items,
      async (x, idx) => {
        await new Promise((res) => setTimeout(res, (5 - idx) * 5)); // reverse delay
        return x;
      },
      5,
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test("handles empty array", async () => {
    const results = await pMap([], async (x: number) => x, 2);
    expect(results).toEqual([]);
  });

  test("handles concurrency higher than item count", async () => {
    const items = [1, 2];
    const results = await pMap(items, async (x) => x + 1, 10);
    expect(results).toEqual([2, 3]);
  });
});
