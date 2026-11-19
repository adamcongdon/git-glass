import { describe, expect, test } from "bun:test";
import {
  ageInDays,
  assembleBoard,
  dedupeRemotes,
  ghStuckReasons,
  glStuckReasons,
  isBotTouched,
  mapGhPr,
  mapGlMr,
  repoHealth,
  sortMrs,
  sortRepos,
  type BoardMr,
  type BoardRepo,
} from "../lib/board";
import type { LocalRemote } from "../lib/issues";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const STALE = 7;
const BOT = { markers: ["triage-engine:", "automated triage bot"], authors: [], branchPrefixes: [] };

const ghRemote: LocalRemote = {
  name: "demo",
  path: "/tmp/demo",
  remoteUrl: "git@github.com:acme/demo.git",
  host: "github.com",
  owner: "acme",
  repo: "demo",
  hostType: "github",
};
const glRemote: LocalRemote = {
  name: "svc",
  path: "/tmp/svc",
  remoteUrl: "https://gitlab.example.com/team/svc.git",
  host: "gitlab.example.com",
  owner: "team",
  repo: "svc",
  hostType: "gitlab",
};

describe("ageInDays", () => {
  test("whole days, never negative", () => {
    expect(ageInDays(daysAgo(3), NOW)).toBe(3);
    expect(ageInDays(new Date(NOW + 5000).toISOString(), NOW)).toBe(0);
    expect(ageInDays("not a date", NOW)).toBe(0);
  });
});

describe("ghStuckReasons", () => {
  const base = { isDraft: false, createdAt: daysAgo(1) };
  test("healthy PR has no reasons", () => {
    expect(
      ghStuckReasons(
        { ...base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checkState: "SUCCESS" },
        STALE,
        NOW,
      ),
    ).toEqual([]);
  });
  test("each reason maps", () => {
    expect(ghStuckReasons({ ...base, checkState: "FAILURE" }, STALE, NOW)).toEqual(["checks_failing"]);
    expect(ghStuckReasons({ ...base, checkState: "ERROR" }, STALE, NOW)).toEqual(["checks_failing"]);
    expect(ghStuckReasons({ ...base, checkState: "PENDING" }, STALE, NOW)).toEqual(["checks_pending"]);
    expect(ghStuckReasons({ ...base, mergeable: "CONFLICTING" }, STALE, NOW)).toEqual(["conflict"]);
    expect(ghStuckReasons({ ...base, mergeStateStatus: "DIRTY" }, STALE, NOW)).toEqual(["conflict"]);
    expect(ghStuckReasons({ ...base, mergeStateStatus: "BEHIND" }, STALE, NOW)).toEqual(["behind"]);
    expect(ghStuckReasons({ ...base, reviewDecision: "CHANGES_REQUESTED" }, STALE, NOW)).toEqual(["changes_requested"]);
    expect(ghStuckReasons({ ...base, reviewDecision: "REVIEW_REQUIRED" }, STALE, NOW)).toEqual(["needs_review"]);
    expect(ghStuckReasons({ ...base, isDraft: true }, STALE, NOW)).toEqual(["draft"]);
    expect(ghStuckReasons({ ...base, createdAt: daysAgo(8) }, STALE, NOW)).toEqual(["old"]);
  });
  test("exactly staleDays old is not old", () => {
    expect(ghStuckReasons({ ...base, createdAt: daysAgo(7) }, STALE, NOW)).toEqual([]);
  });
  test("reasons come out worst first", () => {
    expect(
      ghStuckReasons(
        { isDraft: true, createdAt: daysAgo(30), checkState: "FAILURE", mergeable: "CONFLICTING", reviewDecision: "REVIEW_REQUIRED" },
        STALE,
        NOW,
      ),
    ).toEqual(["checks_failing", "conflict", "needs_review", "draft", "old"]);
  });
});

describe("glStuckReasons", () => {
  const base = { draft: false, createdAt: daysAgo(1) };
  test("mergeable MR has no reasons", () => {
    expect(glStuckReasons({ ...base, detailedMergeStatus: "mergeable", pipelineStatus: "success" }, STALE, NOW)).toEqual([]);
  });
  test("each status maps", () => {
    expect(glStuckReasons({ ...base, pipelineStatus: "failed" }, STALE, NOW)).toEqual(["checks_failing"]);
    expect(glStuckReasons({ ...base, detailedMergeStatus: "ci_must_pass" }, STALE, NOW)).toEqual(["checks_failing"]);
    expect(glStuckReasons({ ...base, detailedMergeStatus: "ci_still_running" }, STALE, NOW)).toEqual(["checks_pending"]);
    expect(glStuckReasons({ ...base, pipelineStatus: "running", detailedMergeStatus: "ci_must_pass" }, STALE, NOW)).toEqual([
      "checks_pending",
    ]);
    expect(glStuckReasons({ ...base, hasConflicts: true }, STALE, NOW)).toEqual(["conflict"]);
    expect(glStuckReasons({ ...base, detailedMergeStatus: "need_rebase" }, STALE, NOW)).toEqual(["behind"]);
    expect(glStuckReasons({ ...base, detailedMergeStatus: "requested_changes" }, STALE, NOW)).toEqual(["changes_requested"]);
    expect(glStuckReasons({ ...base, detailedMergeStatus: "not_approved" }, STALE, NOW)).toEqual(["needs_review"]);
    expect(glStuckReasons({ ...base, detailedMergeStatus: "draft_status" }, STALE, NOW)).toEqual(["draft"]);
    expect(glStuckReasons({ ...base, createdAt: daysAgo(10) }, STALE, NOW)).toEqual(["old"]);
  });
});

describe("isBotTouched", () => {
  test("marker in body or a comment", () => {
    expect(isBotTouched({ body: "Fix\n<!-- triage-engine:fix -->" }, BOT)).toBe(true);
    expect(isBotTouched({ comments: ["hi", "_AI-assisted: drafted by an Automated Triage Bot, reviewed..._"] }, BOT)).toBe(true);
    expect(isBotTouched({ body: "plain human PR", comments: ["lgtm"] }, BOT)).toBe(false);
  });
  test("author and branch rules", () => {
    expect(isBotTouched({ author: "Shepard-Bot" }, { ...BOT, authors: ["shepard-bot"] })).toBe(true);
    expect(isBotTouched({ branch: "triage/fix-12" }, { ...BOT, branchPrefixes: ["triage/"] })).toBe(true);
    expect(isBotTouched({ branch: "feature/x" }, { ...BOT, branchPrefixes: ["triage/"] })).toBe(false);
  });
  test("no rules means never", () => {
    expect(isBotTouched({ body: "triage-engine:" }, { markers: [], authors: [], branchPrefixes: [] })).toBe(false);
  });
});

function mr(partial: Partial<BoardMr>): BoardMr {
  return {
    id: String(partial.number ?? 1),
    host: "github.com",
    hostType: "github",
    owner: "acme",
    repo: "demo",
    number: 1,
    title: "t",
    htmlUrl: "",
    author: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    draft: false,
    mine: false,
    bot: false,
    sourceBranch: null,
    labels: [],
    reasons: [],
    stuck: false,
    ageDays: 1,
    ...partial,
  };
}

describe("sortMrs", () => {
  const list = [
    mr({ number: 1, createdAt: daysAgo(2) }),
    mr({ number: 2, createdAt: daysAgo(9), stuck: true }),
    mr({ number: 3, createdAt: daysAgo(20) }),
    mr({ number: 4, createdAt: daysAgo(3), stuck: true }),
  ];
  test("stuck first, oldest first within each group", () => {
    expect(sortMrs(list).map((m) => m.number)).toEqual([2, 4, 3, 1]);
  });
  test("pure opened-date order oldest first", () => {
    expect(sortMrs(list, { stuckFirst: false }).map((m) => m.number)).toEqual([3, 2, 4, 1]);
  });
  test("newest first toggle", () => {
    expect(sortMrs(list, { stuckFirst: false, direction: "desc" }).map((m) => m.number)).toEqual([1, 4, 2, 3]);
  });
  test("does not mutate input", () => {
    const copy = list.map((m) => m.number);
    sortMrs(list);
    expect(list.map((m) => m.number)).toEqual(copy);
  });
});

describe("repoHealth", () => {
  test("counts open, stuck, oldest, bot", () => {
    const h = repoHealth([mr({ ageDays: 3, stuck: true, bot: true }), mr({ ageDays: 12 })], 4);
    expect(h).toEqual({ openMrs: 2, stuck: 1, oldestDays: 12, openIssues: 4, botMrs: 1 });
  });
  test("empty repo is healthy with no oldest", () => {
    expect(repoHealth([], 0)).toEqual({ openMrs: 0, stuck: 0, oldestDays: null, openIssues: 0, botMrs: 0 });
  });
});

describe("mappers", () => {
  test("GitHub PR maps mine, bot, reasons", () => {
    const row = mapGhPr(
      {
        number: 7,
        title: "Fix",
        url: "https://github.com/acme/demo/pull/7",
        createdAt: daysAgo(9),
        updatedAt: daysAgo(1),
        isDraft: false,
        headRefName: "fix/7",
        body: "<!-- triage-engine:fix -->",
        author: { login: "Me" },
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        labels: { nodes: [{ name: "bug" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
        comments: { nodes: [] },
      },
      ghRemote,
      { login: "me", staleDays: STALE, bot: BOT, nowMs: NOW },
    );
    expect(row.mine).toBe(true);
    expect(row.bot).toBe(true);
    expect(row.reasons).toEqual(["checks_failing", "needs_review", "old"]);
    expect(row.stuck).toBe(true);
    expect(row.ageDays).toBe(9);
    expect(row.labels).toEqual(["bug"]);
  });
  test("GitLab MR maps draft and comments marker", () => {
    const row = mapGlMr(
      {
        iid: 3,
        title: "Draft: x",
        web_url: "https://gitlab.example.com/team/svc/-/merge_requests/3",
        created_at: daysAgo(2),
        updated_at: daysAgo(1),
        draft: true,
        has_conflicts: false,
        detailed_merge_status: "draft_status",
        author: { username: "someone" },
        source_branch: "x",
        labels: ["a"],
      },
      glRemote,
      { login: "me", staleDays: STALE, bot: BOT, comments: ["**Automated triage**\n<!-- triage-engine:verdict -->"], nowMs: NOW },
    );
    expect(row.draft).toBe(true);
    expect(row.mine).toBe(false);
    expect(row.bot).toBe(true);
    expect(row.reasons).toEqual(["draft"]);
  });
});

describe("dedupeRemotes", () => {
  test("keeps one per host/owner/repo", () => {
    const out = dedupeRemotes([ghRemote, { ...ghRemote, path: "/tmp/demo-2", owner: "ACME" }, glRemote]);
    expect(out.length).toBe(2);
    expect(out[0]!.path).toBe("/tmp/demo");
  });
});

describe("assembleBoard", () => {
  test("one failing repo keeps the others and is reported", async () => {
    const { repos, failures } = await assembleBoard(
      [ghRemote, glRemote],
      async (remote) => {
        if (remote.hostType === "gitlab") throw new Error("GitLab 401: Unauthorized");
        return {
          host: remote.host,
          hostType: remote.hostType,
          owner: remote.owner,
          repo: remote.repo,
          mrs: [mr({ number: 5, stuck: true, ageDays: 4 })],
          issues: [],
          moreIssues: 2,
          mrsTruncated: false,
        };
      },
      { staleDays: STALE },
    );
    expect(repos.length).toBe(2);
    const ok = repos.find((r) => r.hostType === "github")!;
    expect(ok.health).toMatchObject({ openMrs: 1, stuck: 1, oldestDays: 4, openIssues: 2 });
    expect(ok.webUrl).toBe("https://github.com/acme/demo");
    const bad = repos.find((r) => r.hostType === "gitlab")!;
    expect(bad.error).toContain("401");
    expect(failures).toEqual([{ host: "gitlab.example.com", remote: "team/svc", message: "GitLab 401: Unauthorized" }]);
  });
});

describe("sortRepos", () => {
  const band = (owner: string, stuck: number, oldest: number | null, open: number): BoardRepo => ({
    key: owner,
    host: "github.com",
    hostType: "github",
    owner,
    repo: "r",
    localPath: "",
    webUrl: null,
    mrs: [],
    issues: [],
    moreIssues: 0,
    mrsTruncated: false,
    health: { openMrs: open, stuck, oldestDays: oldest, openIssues: 0, botMrs: 0 },
  });
  test("stuck repos first, then busy, then quiet", () => {
    const out = sortRepos([band("quiet", 0, null, 0), band("busy", 0, 2, 3), band("stuck-new", 1, 3, 1), band("stuck-old", 1, 20, 1)]);
    expect(out.map((r) => r.owner)).toEqual(["stuck-old", "stuck-new", "busy", "quiet"]);
  });
});
