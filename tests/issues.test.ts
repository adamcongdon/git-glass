import { describe, test, expect, beforeEach } from "bun:test";
import {
  inferPriorityFromLabels,
  updatedCutoffIso,
  sortByUpdatedDesc,
  dedupeIssues,
  filterIssues,
  paginateIssues,
  issueId,
  buildGitHubAttentionQuery,
  remoteKey,
  clearIssuesCache,
  type IssueRow,
} from "../lib/issues";

function row(partial: Partial<IssueRow> & Pick<IssueRow, "number" | "title">): IssueRow {
  return {
    id: partial.id ?? issueId("github.com", "o", "r", partial.number),
    host: partial.host ?? "github.com",
    hostType: partial.hostType ?? "github",
    owner: partial.owner ?? "o",
    repo: partial.repo ?? "r",
    number: partial.number,
    title: partial.title,
    state: partial.state ?? "open",
    htmlUrl: partial.htmlUrl ?? "https://github.com/o/r/issues/1",
    labels: partial.labels ?? [],
    author: partial.author ?? "alice",
    assignees: partial.assignees ?? [],
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: partial.updatedAt ?? "2026-01-02T00:00:00Z",
    comments: partial.comments ?? 0,
    milestone: partial.milestone ?? null,
    priority: partial.priority ?? null,
    localPath: partial.localPath ?? "/tmp/r",
  };
}

beforeEach(() => {
  clearIssuesCache();
});

describe("inferPriorityFromLabels", () => {
  test("detects high from P0/P1/urgent/critical", () => {
    expect(inferPriorityFromLabels(["P0"])).toBe("high");
    expect(inferPriorityFromLabels(["p1"])).toBe("high");
    expect(inferPriorityFromLabels(["urgent"])).toBe("high");
    expect(inferPriorityFromLabels(["critical"])).toBe("high");
    expect(inferPriorityFromLabels(["priority:high"])).toBe("high");
    expect(inferPriorityFromLabels(["priority/high"])).toBe("high");
  });

  test("detects medium and low", () => {
    expect(inferPriorityFromLabels(["P2"])).toBe("medium");
    expect(inferPriorityFromLabels(["medium"])).toBe("medium");
    expect(inferPriorityFromLabels(["P3"])).toBe("low");
    expect(inferPriorityFromLabels(["low"])).toBe("low");
  });

  test("high wins over low when both present", () => {
    expect(inferPriorityFromLabels(["low", "P0"])).toBe("high");
  });

  test("returns null when no priority labels", () => {
    expect(inferPriorityFromLabels(["bug", "enhancement"])).toBeNull();
    expect(inferPriorityFromLabels([])).toBeNull();
  });
});

describe("updatedCutoffIso", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");

  test("any → null", () => {
    expect(updatedCutoffIso("any", now)).toBeNull();
  });

  test("24h subtracts one day", () => {
    expect(updatedCutoffIso("24h", now)).toBe("2026-07-13T12:00:00.000Z");
  });

  test("7d subtracts seven days", () => {
    expect(updatedCutoffIso("7d", now)).toBe("2026-07-07T12:00:00.000Z");
  });
});

describe("sortByUpdatedDesc", () => {
  test("newest updated first", () => {
    const a = row({ number: 1, title: "a", updatedAt: "2026-01-01T00:00:00Z" });
    const b = row({ number: 2, title: "b", updatedAt: "2026-06-01T00:00:00Z" });
    const c = row({ number: 3, title: "c", updatedAt: "2026-03-01T00:00:00Z" });
    expect(sortByUpdatedDesc([a, b, c]).map((i) => i.number)).toEqual([2, 3, 1]);
  });
});

describe("dedupeIssues", () => {
  test("keeps first of duplicate ids", () => {
    const a = row({ number: 1, title: "first", id: "github.com:o/r#1" });
    const b = row({ number: 1, title: "second", id: "github.com:o/r#1" });
    const out = dedupeIssues([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("first");
  });
});

describe("filterIssues", () => {
  const base = [
    row({
      number: 1,
      title: "gh open",
      hostType: "github",
      state: "open",
      labels: ["bug", "P1"],
      author: "alice",
      assignees: ["bob"],
      updatedAt: "2026-07-14T00:00:00Z",
      owner: "acme",
      repo: "web",
    }),
    row({
      number: 2,
      title: "gl closed",
      hostType: "gitlab",
      host: "gitlab.example.com",
      state: "closed",
      labels: ["feature"],
      author: "carol",
      assignees: [],
      updatedAt: "2026-01-01T00:00:00Z",
      owner: "acme",
      repo: "api",
    }),
  ];

  test("filters by host", () => {
    expect(filterIssues(base, { host: "github" })).toHaveLength(1);
    expect(filterIssues(base, { host: "gitlab" })).toHaveLength(1);
  });

  test("filters by state", () => {
    expect(filterIssues(base, { state: "open" })).toHaveLength(1);
    expect(filterIssues(base, { state: "closed" })).toHaveLength(1);
  });

  test("filters by label (case-insensitive)", () => {
    expect(filterIssues(base, { label: "BUG" })).toHaveLength(1);
  });

  test("filters by author and assignee", () => {
    expect(filterIssues(base, { author: "alice" })).toHaveLength(1);
    expect(filterIssues(base, { assignee: "bob" })).toHaveLength(1);
    expect(filterIssues(base, { assignee: "nobody" })).toHaveLength(0);
  });

  test("filters by repoKey", () => {
    expect(filterIssues(base, { repoKey: "acme/web" })).toHaveLength(1);
  });

  test("filters by updated preset", () => {
    const now = Date.parse("2026-07-14T12:00:00Z");
    expect(filterIssues(base, { updated: "7d", nowMs: now })).toHaveLength(1);
    expect(filterIssues(base, { updated: "any", nowMs: now })).toHaveLength(2);
  });
});

describe("paginateIssues", () => {
  const items = Array.from({ length: 55 }, (_, i) =>
    row({ number: i + 1, title: `t${i + 1}` }),
  );

  test("page 1 of 50 has more", () => {
    const r = paginateIssues(items, 1, 50);
    expect(r.pageItems).toHaveLength(50);
    expect(r.hasMore).toBe(true);
    expect(r.totalMatched).toBe(55);
  });

  test("page 2 returns remainder", () => {
    const r = paginateIssues(items, 2, 50);
    expect(r.pageItems).toHaveLength(5);
    expect(r.hasMore).toBe(false);
  });
});

describe("buildGitHubAttentionQuery", () => {
  test("open produces three qualifier queries", () => {
    const q = buildGitHubAttentionQuery("open");
    expect(q).toContain("is:issue");
    expect(q).toContain("is:open");
    expect(q).toContain("assignee:@me");
    expect(q).toContain("author:@me");
    expect(q).toContain("mentions:@me");
  });

  test("all omits state qualifier", () => {
    const q = buildGitHubAttentionQuery("all");
    expect(q).not.toContain("is:open");
    expect(q).not.toContain("is:closed");
  });
});

describe("issueId / remoteKey", () => {
  test("stable ids", () => {
    expect(issueId("GitHub.com", "Ow", "Rp", 9)).toBe("github.com:Ow/Rp#9");
    expect(remoteKey("Ow", "Rp")).toBe("ow/rp");
  });
});
