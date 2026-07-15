import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseWindow, scoreActivity, getRepoActivity, getLeaderboard, slugifyPath, getClaudeCostMap } from "../lib/leaderboard";

// ─── parseWindow ────────────────────────────────────────────────────────────

describe("parseWindow", () => {
  test("'7d' returns { days: 7, label: '7d' }", () => {
    expect(parseWindow("7d")).toEqual({ days: 7, label: "7d" });
  });

  test("'30d' returns { days: 30, label: '30d' }", () => {
    expect(parseWindow("30d")).toEqual({ days: 30, label: "30d" });
  });

  test("'90d' returns { days: 90, label: '90d' }", () => {
    expect(parseWindow("90d")).toEqual({ days: 90, label: "90d" });
  });

  test("'all' returns { days: 'all', label: 'all' }", () => {
    expect(parseWindow("all")).toEqual({ days: "all", label: "all" });
  });

  test("undefined defaults to 30d", () => {
    expect(parseWindow(undefined)).toEqual({ days: 30, label: "30d" });
  });

  test("invalid input throws", () => {
    expect(() => parseWindow("bad")).toThrow();
  });

  test("'0d' throws", () => {
    expect(() => parseWindow("0d")).toThrow();
  });

  test("'365d' throws", () => {
    expect(() => parseWindow("365d")).toThrow();
  });
});

// ─── slugifyPath ────────────────────────────────────────────────────────────

describe("slugifyPath", () => {
  test("replaces / and . with -", () => {
    expect(slugifyPath("/Users/adam.congdon/code/feedback-tool")).toBe(
      "-Users-adam-congdon-code-feedback-tool",
    );
  });

  test("handles paths with dots in directory names", () => {
    expect(slugifyPath("/Users/x/code/foo.bar/baz")).toBe(
      "-Users-x-code-foo-bar-baz",
    );
  });
});

// ─── getClaudeCostMap ───────────────────────────────────────────────────────

describe("getClaudeCostMap", () => {
  let prevCostRoots: string | undefined;
  let tmpPaiDir: string;

  beforeEach(async () => {
    prevCostRoots = process.env.GLASS_COST_ROOTS;
    tmpPaiDir = join(tmpdir(), `pai-test-${Date.now()}-${Math.random()}`);
    await mkdir(join(tmpPaiDir, "MEMORY", "STATE"), { recursive: true });
    process.env.GLASS_COST_ROOTS = tmpPaiDir;
  });

  afterEach(async () => {
    if (prevCostRoots === undefined) delete process.env.GLASS_COST_ROOTS;
    else process.env.GLASS_COST_ROOTS = prevCostRoots;
    await rm(tmpPaiDir, { recursive: true, force: true });
  });

  test("returns map when usage-cache.json present", async () => {
    await writeFile(
      join(tmpPaiDir, "MEMORY", "STATE", "usage-cache.json"),
      JSON.stringify({
        project_costs: {
          month_used_cents: { "-Users-x-foo": 1234, "-Users-x-bar": 0 },
        },
      }),
    );
    const map = await getClaudeCostMap();
    expect(map["-Users-x-foo"]).toBe(1234);
    expect(map["-Users-x-bar"]).toBe(0);
  });

  test("returns empty object when file missing", async () => {
    const map = await getClaudeCostMap();
    expect(map).toEqual({});
  });

  test("returns empty object when file is malformed JSON", async () => {
    await writeFile(
      join(tmpPaiDir, "MEMORY", "STATE", "usage-cache.json"),
      "{not json",
    );
    const map = await getClaudeCostMap();
    expect(map).toEqual({});
  });

  test("aggregates MTD cents from session-costs.jsonl", async () => {
    await mkdir(join(tmpPaiDir, "MEMORY", "OBSERVABILITY"), { recursive: true });
    const thisMonth = new Date().toISOString();
    const lastMonth = new Date(Date.now() - 40 * 86400000).toISOString();
    const lines = [
      JSON.stringify({
        project: "-Users-x-foo",
        costTotal: 1.5,
        lastTimestamp: thisMonth,
      }),
      JSON.stringify({
        project: "-Users-x-foo",
        costTotal: 0.25,
        lastTimestamp: thisMonth,
      }),
      JSON.stringify({
        project: "-Users-x-bar",
        costTotal: 9.99,
        lastTimestamp: lastMonth,
      }),
    ];
    await writeFile(
      join(tmpPaiDir, "MEMORY", "OBSERVABILITY", "session-costs.jsonl"),
      lines.join("\n") + "\n",
    );
    const map = await getClaudeCostMap();
    expect(map["-Users-x-foo"]).toBe(175); // 1.5 + 0.25 → 175 cents
    expect(map["-Users-x-bar"]).toBeUndefined(); // outside MTD
  });
});

// ─── scoreActivity ──────────────────────────────────────────────────────────

describe("scoreActivity", () => {
  const fixedNow = new Date("2026-05-14T12:00:00Z");

  test("returns 0 when commits === 0", () => {
    const stats = {
      commits: 0,
      additions: 100,
      deletions: 50,
      filesChanged: 10,
      lastCommitDate: "2026-05-13T12:00:00Z",
      lastCommitSha: "abc123",
    };
    expect(scoreActivity(stats, 30, fixedNow)).toBe(0);
  });

  test("returns 0 for 'all' window with zero commits", () => {
    const stats = {
      commits: 0,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      lastCommitDate: "2026-05-13T12:00:00Z",
      lastCommitSha: "abc123",
    };
    expect(scoreActivity(stats, "all", fixedNow)).toBe(0);
  });

  test("higher-commit repo scores higher than lower-commit repo (same recency)", () => {
    const recent = "2026-05-14T10:00:00Z"; // 2 hours ago from fixedNow
    const highCommits = {
      commits: 20,
      additions: 100,
      deletions: 50,
      filesChanged: 10,
      lastCommitDate: recent,
      lastCommitSha: "abc",
    };
    const lowCommits = {
      commits: 2,
      additions: 100,
      deletions: 50,
      filesChanged: 10,
      lastCommitDate: recent,
      lastCommitSha: "def",
    };
    expect(scoreActivity(highCommits, 30, fixedNow)).toBeGreaterThan(
      scoreActivity(lowCommits, 30, fixedNow)
    );
  });

  test("same inputs produce same output (determinism)", () => {
    const stats = {
      commits: 5,
      additions: 200,
      deletions: 80,
      filesChanged: 12,
      lastCommitDate: "2026-05-13T10:00:00Z",
      lastCommitSha: "xyz789",
    };
    const score1 = scoreActivity(stats, 30, fixedNow);
    const score2 = scoreActivity(stats, 30, fixedNow);
    expect(score1).toBe(score2);
  });

  test("uses correct formula: commits*10 + filesChanged + lines*0.05 + recency", () => {
    // commits=1, filesChanged=0, additions=0, deletions=0
    // lastCommitDate = same instant as now → daysSinceLast ~0 → recencyBonus = 50*exp(0) = 50
    // halfLife = max(30/4, 3) = 7.5
    // score ≈ 10 + 0 + 0 + 50 = 60
    const stats = {
      commits: 1,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      lastCommitDate: fixedNow.toISOString(),
      lastCommitSha: "t1",
    };
    const score = scoreActivity(stats, 30, fixedNow);
    // Should be very close to 60 (daysSinceLast ≈ 0 → recencyBonus ≈ 50)
    expect(score).toBeGreaterThan(59);
    expect(score).toBeLessThanOrEqual(60.1);
  });

  test("recency decays over time", () => {
    const statsOld = {
      commits: 1,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      lastCommitDate: new Date(fixedNow.getTime() - 30 * 86400000).toISOString(), // 30 days ago
      lastCommitSha: "old",
    };
    const statsNew = {
      commits: 1,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      lastCommitDate: new Date(fixedNow.getTime() - 1 * 86400000).toISOString(), // 1 day ago
      lastCommitSha: "new",
    };
    expect(scoreActivity(statsNew, 30, fixedNow)).toBeGreaterThan(
      scoreActivity(statsOld, 30, fixedNow)
    );
  });

  test("'all' window uses halfLife=30", () => {
    // With 'all' and lastCommit=now, score ≈ 10 + 0 + 0 + 50*exp(0/30) = 60
    const stats = {
      commits: 1,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      lastCommitDate: fixedNow.toISOString(),
      lastCommitSha: "all1",
    };
    const score = scoreActivity(stats, "all", fixedNow);
    expect(score).toBeGreaterThan(59);
    expect(score).toBeLessThanOrEqual(60.1);
  });
});

// ─── getRepoActivity integration ────────────────────────────────────────────

describe("getRepoActivity (integration)", () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = join(tmpdir(), `leaderboard-test-${Date.now()}`);
    await mkdir(tmpRepo, { recursive: true });

    // Git init
    const exec = async (cmd: string, env?: Record<string, string>) => {
      const parts = cmd.split(" ");
      const proc = Bun.spawn(parts, {
        cwd: tmpRepo,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      });
      await proc.exited;
    };

    await exec("git init");
    await exec("git config user.email test@example.com");
    await exec("git config user.name Test");

    // Create first commit with a specific date (2 days ago)
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    await writeFile(join(tmpRepo, "file1.txt"), "hello world\n");
    await exec("git add file1.txt");
    const commitEnv1: Record<string, string> = {
      GIT_AUTHOR_DATE: twoDaysAgo,
      GIT_COMMITTER_DATE: twoDaysAgo,
    };
    const proc1 = Bun.spawn(
      ["git", "commit", "-m", "first commit"],
      { cwd: tmpRepo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...commitEnv1 } }
    );
    await proc1.exited;

    // Create second commit yesterday
    const yesterday = new Date(Date.now() - 1 * 86400000).toISOString();
    await writeFile(join(tmpRepo, "file2.txt"), "more content\nline2\nline3\n");
    await exec("git add file2.txt");
    const proc2 = Bun.spawn(
      ["git", "commit", "-m", "second commit"],
      {
        cwd: tmpRepo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_DATE: yesterday,
          GIT_COMMITTER_DATE: yesterday,
        },
      }
    );
    await proc2.exited;
  });

  afterEach(async () => {
    await rm(tmpRepo, { recursive: true, force: true });
  });

  test("returns correct commit count for since=yesterday", async () => {
    // since = 3 days ago to capture both commits
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const result = await getRepoActivity(tmpRepo, threeDaysAgo);
    expect(result.commits).toBe(2);
  });

  test("returns lastCommitDate as non-empty string", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const result = await getRepoActivity(tmpRepo, threeDaysAgo);
    expect(result.lastCommitDate).toBeTruthy();
    expect(typeof result.lastCommitDate).toBe("string");
  });

  test("returned shape matches expected fields", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const result = await getRepoActivity(tmpRepo, threeDaysAgo);
    expect(result).toHaveProperty("commits");
    expect(result).toHaveProperty("additions");
    expect(result).toHaveProperty("deletions");
    expect(result).toHaveProperty("filesChanged");
    expect(result).toHaveProperty("lastCommitDate");
    expect(result).toHaveProperty("lastCommitSha");
  });

  test("commits count is 0 when since is after all commits", async () => {
    // since = 1 hour from now (future) → no commits in window
    const future = new Date(Date.now() + 3600000).toISOString();
    const result = await getRepoActivity(tmpRepo, future);
    expect(result.commits).toBe(0);
  });

  test("null sinceISO (all window) returns all commits", async () => {
    const result = await getRepoActivity(tmpRepo, null);
    expect(result.commits).toBe(2);
  });

  test("additions and filesChanged are non-negative numbers", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const result = await getRepoActivity(tmpRepo, threeDaysAgo);
    expect(result.additions).toBeGreaterThanOrEqual(0);
    expect(result.deletions).toBeGreaterThanOrEqual(0);
    expect(result.filesChanged).toBeGreaterThanOrEqual(1);
  });

  test("lastCommitSha is a non-empty hex string", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const result = await getRepoActivity(tmpRepo, threeDaysAgo);
    expect(result.lastCommitSha).toMatch(/^[0-9a-f]+$/);
    expect(result.lastCommitSha.length).toBeGreaterThan(5);
  });
});

// ─── getLeaderboard integration ─────────────────────────────────────────────

describe("getLeaderboard integration", () => {
  let tmpScanDir: string;
  let tmpRepoDir: string;

  beforeEach(async () => {
    tmpScanDir = join(tmpdir(), `leaderboard-int-${Date.now()}`);
    await mkdir(tmpScanDir, { recursive: true });
    tmpRepoDir = join(tmpScanDir, "test-repo");
    await mkdir(tmpRepoDir, { recursive: true });

    const exec = async (cmd: string, env?: Record<string, string>) => {
      const parts = cmd.split(" ");
      const proc = Bun.spawn(parts, {
        cwd: tmpRepoDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      });
      await proc.exited;
    };

    await exec("git init");
    await exec("git config user.email lb@example.com");
    await exec("git config user.name Leaderboard");

    const yesterday = new Date(Date.now() - 86400000).toISOString();
    await writeFile(join(tmpRepoDir, "main.ts"), "export const x = 1;\n");
    await exec("git add main.ts");
    const proc = Bun.spawn(["git", "commit", "-m", "initial"], {
      cwd: tmpRepoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_DATE: yesterday,
        GIT_COMMITTER_DATE: yesterday,
      },
    });
    await proc.exited;
  });

  afterEach(async () => {
    await rm(tmpScanDir, { recursive: true, force: true });
  });

  test("returns correct top-level shape for window=30d", async () => {
    const config = { scanPaths: [tmpScanDir], ignoredRepos: [] };
    const data = await getLeaderboard(config, "30d");

    expect(data).toHaveProperty("window", "30d");
    expect(data).toHaveProperty("windowDays", 30);
    expect(data).toHaveProperty("generatedAt");
    expect(typeof data.generatedAt).toBe("string");
    expect(data).toHaveProperty("totalRepos");
    expect(data.totalRepos).toBeGreaterThanOrEqual(1);
    expect(data).toHaveProperty("repos");
    expect(Array.isArray(data.repos)).toBe(true);
  });

  test("each repo entry has required fields", async () => {
    const config = { scanPaths: [tmpScanDir], ignoredRepos: [] };
    const data = await getLeaderboard(config, "30d");

    expect(data.repos.length).toBeGreaterThanOrEqual(1);
    const repo = data.repos[0];
    expect(repo).toHaveProperty("name");
    expect(repo).toHaveProperty("path");
    expect(repo).toHaveProperty("commits");
    expect(repo).toHaveProperty("additions");
    expect(repo).toHaveProperty("deletions");
    expect(repo).toHaveProperty("filesChanged");
    expect(repo).toHaveProperty("lastCommitDate");
    expect(repo).toHaveProperty("score");
    expect(repo).toHaveProperty("host");
    expect(repo).toHaveProperty("owner");
    expect(repo).toHaveProperty("remoteUrl");
    expect(repo).toHaveProperty("claudeCostCents");
  });

  test("repos are sorted by score descending", async () => {
    const config = { scanPaths: [tmpScanDir], ignoredRepos: [] };
    const data = await getLeaderboard(config, "30d");

    const scores = data.repos.map(r => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  test("ignoredRepos are excluded from results", async () => {
    const config = {
      scanPaths: [tmpScanDir],
      ignoredRepos: [tmpRepoDir],
    };
    const data = await getLeaderboard(config, "30d");
    const found = data.repos.find(r => r.path === tmpRepoDir || r.name === "test-repo");
    expect(found).toBeUndefined();
  });

  test("window=all returns results", async () => {
    const config = { scanPaths: [tmpScanDir], ignoredRepos: [] };
    const data = await getLeaderboard(config, "all");
    expect(data.window).toBe("all");
    expect(data.windowDays).toBe("all");
    expect(Array.isArray(data.repos)).toBe(true);
  });
});
