import { describe, test, expect } from "bun:test";
import {
  normalizeHiddenHost,
  hiddenRepoKey,
  parseOwnerRepo,
  isHiddenRepo,
  shouldApplyHiddenFilter,
  excludeHiddenRows,
  excludeHiddenNotifications,
  normalizeHiddenRepo,
  addHiddenRepo,
  removeHiddenRepo,
  formatHiddenRepo,
  type HiddenRepo,
} from "../lib/inboxHide";

describe("normalizeHiddenHost", () => {
  test("strips scheme and trailing slash, lowercases", () => {
    expect(normalizeHiddenHost("https://GitHub.com/")).toBe("github.com");
    expect(normalizeHiddenHost("gitlab.example.com")).toBe("gitlab.example.com");
  });
});

describe("hiddenRepoKey", () => {
  test("case-insensitive host/owner/repo", () => {
    expect(hiddenRepoKey("GitHub.com", "Acme", "App")).toBe(
      hiddenRepoKey("github.com", "acme", "app"),
    );
  });
});

describe("parseOwnerRepo", () => {
  test("simple owner/repo", () => {
    expect(parseOwnerRepo("acme/app")).toEqual({ owner: "acme", repo: "app" });
  });

  test("GitLab nested groups", () => {
    expect(parseOwnerRepo("group/sub/project")).toEqual({
      owner: "group/sub",
      repo: "project",
    });
  });

  test("rejects invalid", () => {
    expect(parseOwnerRepo("")).toBeNull();
    expect(parseOwnerRepo("only")).toBeNull();
    expect(parseOwnerRepo("/")).toBeNull();
  });
});

describe("isHiddenRepo / filter", () => {
  const hidden: HiddenRepo[] = [
    { host: "github.com", owner: "acme", repo: "legacy" },
    { host: "gitlab.example.com", owner: "team", repo: "noise" },
  ];

  test("matches host+owner+repo", () => {
    expect(isHiddenRepo(hidden, "github.com", "acme", "legacy")).toBe(true);
    expect(isHiddenRepo(hidden, "github.com", "acme", "other")).toBe(false);
    expect(isHiddenRepo(hidden, "gitlab.example.com", "team", "noise")).toBe(true);
  });

  test("shouldApplyHiddenFilter false when focusRepo set", () => {
    expect(shouldApplyHiddenFilter(null)).toBe(true);
    expect(shouldApplyHiddenFilter("")).toBe(true);
    expect(shouldApplyHiddenFilter("acme/legacy")).toBe(false);
  });

  test("excludeHiddenRows drops matches unless focus", () => {
    const rows = [
      { host: "github.com", owner: "acme", repo: "legacy", id: "1" },
      { host: "github.com", owner: "acme", repo: "keep", id: "2" },
    ];
    expect(excludeHiddenRows(rows, hidden).map((r) => r.id)).toEqual(["2"]);
    expect(excludeHiddenRows(rows, hidden, { focusRepo: "acme/legacy" }).map((r) => r.id)).toEqual([
      "1",
      "2",
    ]);
  });

  test("excludeHiddenNotifications uses repo string", () => {
    const rows = [
      { host: "github.com", repo: "acme/legacy", id: "a" },
      { host: "github.com", repo: "acme/keep", id: "b" },
      { host: "github.com", repo: null, id: "c" },
    ];
    expect(excludeHiddenNotifications(rows, hidden).map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("add/remove/normalize", () => {
  test("normalizeHiddenRepo", () => {
    expect(normalizeHiddenRepo("https://GitHub.com", " acme ", " legacy ")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "legacy",
    });
    expect(normalizeHiddenRepo("", "a", "b")).toBeNull();
    expect(normalizeHiddenRepo("h", "a..", "b")).toBeNull();
  });

  test("add dedupes by key", () => {
    const list = addHiddenRepo([], { host: "github.com", owner: "a", repo: "b" });
    const again = addHiddenRepo(list, { host: "GitHub.com", owner: "A", repo: "B" });
    expect(again).toHaveLength(1);
  });

  test("remove by key", () => {
    const list: HiddenRepo[] = [
      { host: "github.com", owner: "a", repo: "b" },
      { host: "github.com", owner: "c", repo: "d" },
    ];
    expect(removeHiddenRepo(list, "github.com", "a", "b")).toEqual([
      { host: "github.com", owner: "c", repo: "d" },
    ]);
  });

  test("formatHiddenRepo", () => {
    expect(formatHiddenRepo({ host: "github.com", owner: "a", repo: "b" })).toBe("a/b");
    expect(formatHiddenRepo({ host: "gitlab.com", owner: "a", repo: "b" })).toBe(
      "a/b (gitlab.com)",
    );
  });
});
