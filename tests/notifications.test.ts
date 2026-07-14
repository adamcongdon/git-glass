import { describe, test, expect } from "bun:test";
import {
  mapGhReason,
  isCiOrBot,
  isParticipatingReason,
  filterNotificationDefaults,
  groupByReason,
  countUndone,
  dedupeNotificationRows,
  type NotificationRow,
  type NotifReason,
} from "../lib/notifications";

function row(
  partial: Partial<NotificationRow> & Pick<NotificationRow, "id" | "reason">,
): NotificationRow {
  return {
    id: partial.id,
    host: partial.host ?? "github.com",
    hostType: partial.hostType ?? "github",
    account: partial.account ?? "me",
    reason: partial.reason,
    unread: partial.unread ?? true,
    done: partial.done ?? false,
    title: partial.title ?? "t",
    repo: partial.repo ?? "o/r",
    subjectType: partial.subjectType ?? "Issue",
    htmlUrl: partial.htmlUrl ?? "https://github.com/o/r/issues/1",
    updatedAt: partial.updatedAt ?? "2026-07-14T00:00:00Z",
    threadId: partial.threadId ?? partial.id,
    muteSupported: partial.muteSupported ?? true,
    isLocalRemote: partial.isLocalRemote ?? true,
  };
}

describe("mapGhReason", () => {
  test("maps review / assign / mention / author", () => {
    expect(mapGhReason("review_requested")).toBe("review");
    expect(mapGhReason("assign")).toBe("assign");
    expect(mapGhReason("mention")).toBe("mention");
    expect(mapGhReason("author")).toBe("author");
    expect(mapGhReason("comment")).toBe("mention");
    expect(mapGhReason("ci_activity")).toBe("ci");
    expect(mapGhReason("subscribed")).toBe("subscribed");
    expect(mapGhReason("state_change")).toBe("other");
  });
});

describe("isCiOrBot", () => {
  test("detects ci reason and bot authors in title", () => {
    expect(isCiOrBot(row({ id: "1", reason: "ci" }))).toBe(true);
    expect(isCiOrBot(row({ id: "2", reason: "review", title: "chore(deps): bump x by dependabot" }))).toBe(
      true,
    );
    expect(isCiOrBot(row({ id: "3", reason: "review", title: "fix login" }))).toBe(false);
  });
});

describe("isParticipatingReason", () => {
  test("participating excludes watching/subscribed/ci by default", () => {
    expect(isParticipatingReason("review")).toBe(true);
    expect(isParticipatingReason("assign")).toBe(true);
    expect(isParticipatingReason("mention")).toBe(true);
    expect(isParticipatingReason("author")).toBe(true);
    expect(isParticipatingReason("watching")).toBe(false);
    expect(isParticipatingReason("subscribed")).toBe(false);
    expect(isParticipatingReason("ci")).toBe(false);
    expect(isParticipatingReason("bot")).toBe(false);
  });
});

describe("filterNotificationDefaults", () => {
  const base: NotificationRow[] = [
    row({ id: "a", reason: "review", isLocalRemote: true, done: false }),
    row({ id: "b", reason: "review", isLocalRemote: false, done: false }),
    row({ id: "c", reason: "ci", isLocalRemote: true, done: false }),
    row({ id: "d", reason: "subscribed", isLocalRemote: true, done: false }),
    row({ id: "e", reason: "review", isLocalRemote: true, done: true }),
    row({
      id: "f",
      reason: "mention",
      isLocalRemote: true,
      done: false,
      title: "bump lodash by dependabot[bot]",
    }),
  ];

  test("default: local + participating + not done + no bots", () => {
    const out = filterNotificationDefaults(base, {
      localOnly: true,
      includeCi: false,
      includeBots: false,
      includeWatching: false,
    });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  test("includeCi shows ci local", () => {
    const out = filterNotificationDefaults(base, {
      localOnly: true,
      includeCi: true,
      includeBots: false,
      includeWatching: false,
    });
    expect(out.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  test("localOnly false includes non-local participating", () => {
    const out = filterNotificationDefaults(base, {
      localOnly: false,
      includeCi: false,
      includeBots: false,
      includeWatching: false,
    });
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("includeBots includes dependabot titles", () => {
    const out = filterNotificationDefaults(base, {
      localOnly: true,
      includeCi: false,
      includeBots: true,
      includeWatching: false,
    });
    expect(out.map((r) => r.id).sort()).toEqual(["a", "f"]);
  });
});

describe("groupByReason", () => {
  test("orders reason groups Review first", () => {
    const rows = [
      row({ id: "1", reason: "author" }),
      row({ id: "2", reason: "review" }),
      row({ id: "3", reason: "assign" }),
    ];
    const groups = groupByReason(rows);
    expect(groups.map((g) => g.reason)).toEqual(["review", "assign", "author"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["2"]);
  });
});

describe("countUndone", () => {
  test("counts not-done only", () => {
    expect(
      countUndone([
        row({ id: "1", reason: "review", done: false }),
        row({ id: "2", reason: "review", done: true }),
      ]),
    ).toBe(1);
  });
});

describe("dedupeNotificationRows", () => {
  test("keeps first by id", () => {
    const a = row({ id: "x", reason: "review", title: "first" });
    const b = row({ id: "x", reason: "review", title: "second" });
    expect(dedupeNotificationRows([a, b])).toHaveLength(1);
    expect(dedupeNotificationRows([a, b])[0].title).toBe("first");
  });
});
