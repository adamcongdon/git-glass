import { describe, test, expect } from "bun:test";
import {
  buildGitHubWorkQueries,
  mapAttention,
  sortWorkSections,
  type WorkRow,
  type WorkAttention,
} from "../lib/work";

function work(
  partial: Partial<WorkRow> & Pick<WorkRow, "number" | "title" | "attention" | "kind">,
): WorkRow {
  return {
    id: partial.id ?? `github.com:o/r#${partial.number}`,
    host: partial.host ?? "github.com",
    hostType: partial.hostType ?? "github",
    owner: partial.owner ?? "o",
    repo: partial.repo ?? "r",
    number: partial.number,
    title: partial.title,
    state: partial.state ?? "open",
    htmlUrl: partial.htmlUrl ?? "https://github.com/o/r/pull/1",
    labels: partial.labels ?? [],
    author: partial.author ?? "alice",
    assignees: partial.assignees ?? [],
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: partial.updatedAt ?? "2026-07-01T00:00:00Z",
    comments: partial.comments ?? 0,
    milestone: partial.milestone ?? null,
    priority: partial.priority ?? null,
    localPath: partial.localPath ?? "/tmp/r",
    kind: partial.kind,
    attention: partial.attention,
  };
}

describe("buildGitHubWorkQueries", () => {
  test("emits issue and pr attention queries including review-requested", () => {
    const qs = buildGitHubWorkQueries("open");
    expect(qs.some((q) => q.includes("is:issue") && q.includes("assignee:@me"))).toBe(true);
    expect(qs.some((q) => q.includes("is:pr") && q.includes("review-requested:@me"))).toBe(true);
    expect(qs.some((q) => q.includes("is:pr") && q.includes("author:@me"))).toBe(true);
    expect(qs.every((q) => q.includes("is:open"))).toBe(true);
  });

  test("closed state uses is:closed", () => {
    const qs = buildGitHubWorkQueries("closed");
    expect(qs.every((q) => q.includes("is:closed"))).toBe(true);
  });
});

describe("mapAttention", () => {
  test("maps query source to attention", () => {
    expect(mapAttention("review-requested")).toBe("review");
    expect(mapAttention("assignee")).toBe("assign");
    expect(mapAttention("author")).toBe("author");
    expect(mapAttention("mentions")).toBe("mention");
    expect(mapAttention("other")).toBe("other");
  });
});

describe("sortWorkSections", () => {
  test("reviews first, then assign, then rest by updated", () => {
    const rows = [
      work({
        number: 1,
        title: "old mention",
        attention: "mention",
        kind: "issue",
        updatedAt: "2026-06-01T00:00:00Z",
      }),
      work({
        number: 2,
        title: "review",
        attention: "review",
        kind: "pr",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      work({
        number: 3,
        title: "assign",
        attention: "assign",
        kind: "issue",
        updatedAt: "2026-07-01T00:00:00Z",
      }),
      work({
        number: 4,
        title: "newer review",
        attention: "review",
        kind: "pr",
        updatedAt: "2026-07-10T00:00:00Z",
      }),
    ];
    const sorted = sortWorkSections(rows);
    expect(sorted.map((r) => r.number)).toEqual([4, 2, 3, 1]);
  });

  test("groups by section order", () => {
    const rows = [
      work({ number: 1, title: "a", attention: "author" as WorkAttention, kind: "issue" }),
      work({ number: 2, title: "r", attention: "review", kind: "pr" }),
    ];
    const sections = sortWorkSections(rows, { asSections: true });
    expect(sections.map((s) => s.attention)).toEqual(["review", "author"]);
  });
});
