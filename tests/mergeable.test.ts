import { describe, test, expect } from "bun:test";
import {
  isReady,
  reasonsNotReady,
  pickDefaultMethod,
  mapGhMergeability,
  mapGlMergeability,
  type MergeMethod,
} from "../lib/mergeable";

describe("isReady", () => {
  test("true only when checks + approved + not behind + mergeable", () => {
    expect(
      isReady({ checksClean: true, approved: true, notBehind: true, mergeable: true }),
    ).toBe(true);
    expect(
      isReady({ checksClean: false, approved: true, notBehind: true, mergeable: true }),
    ).toBe(false);
    expect(
      isReady({ checksClean: true, approved: false, notBehind: true, mergeable: true }),
    ).toBe(false);
    expect(
      isReady({ checksClean: true, approved: true, notBehind: false, mergeable: true }),
    ).toBe(false);
    expect(
      isReady({ checksClean: true, approved: true, notBehind: true, mergeable: false }),
    ).toBe(false);
  });
});

describe("reasonsNotReady", () => {
  test("lists missing criteria", () => {
    expect(
      reasonsNotReady({
        checksClean: false,
        approved: false,
        notBehind: false,
        mergeable: false,
      }),
    ).toEqual(["checks failing", "not approved", "behind base", "not mergeable"]);
    expect(
      reasonsNotReady({
        checksClean: true,
        approved: true,
        notBehind: true,
        mergeable: true,
      }),
    ).toEqual([]);
  });
});

describe("pickDefaultMethod", () => {
  test("prefers remembered if allowed", () => {
    expect(pickDefaultMethod(["merge", "squash", "rebase"], "squash")).toBe("squash");
  });
  test("falls back to first allowed when remembered disallowed", () => {
    expect(pickDefaultMethod(["merge", "rebase"], "squash")).toBe("merge");
  });
  test("empty allowed returns merge", () => {
    expect(pickDefaultMethod([], "squash")).toBe("merge");
  });
});

describe("mapGhMergeability", () => {
  test("maps clean + approved + not behind", () => {
    const r = mapGhMergeability({
      mergeable: true,
      mergeable_state: "clean",
      draft: false,
      reviewDecision: "APPROVED",
      checksConclusion: "success",
      behindBy: 0,
    });
    expect(r.checksClean).toBe(true);
    expect(r.approved).toBe(true);
    expect(r.notBehind).toBe(true);
    expect(r.mergeable).toBe(true);
    expect(isReady(r)).toBe(true);
  });

  test("draft is not mergeable", () => {
    const r = mapGhMergeability({
      mergeable: true,
      mergeable_state: "clean",
      draft: true,
      reviewDecision: "APPROVED",
      checksConclusion: "success",
      behindBy: 0,
    });
    expect(r.mergeable).toBe(false);
  });

  test("behind base", () => {
    const r = mapGhMergeability({
      mergeable: true,
      mergeable_state: "behind",
      draft: false,
      reviewDecision: "APPROVED",
      checksConclusion: "success",
      behindBy: 3,
    });
    expect(r.notBehind).toBe(false);
  });

  test("changes requested blocks approval", () => {
    const r = mapGhMergeability({
      mergeable: true,
      mergeable_state: "clean",
      draft: false,
      reviewDecision: "CHANGES_REQUESTED",
      checksConclusion: "success",
      behindBy: 0,
    });
    expect(r.approved).toBe(false);
  });
});

describe("mapGlMergeability", () => {
  test("can_be_merged + approvals + success pipeline", () => {
    const r = mapGlMergeability({
      detailed_merge_status: "mergeable",
      draft: false,
      has_conflicts: false,
      approvalsLeft: 0,
      pipelineStatus: "success",
      divergedCommitsCount: 0,
    });
    expect(isReady(r)).toBe(true);
  });

  test("need_rebase is behind", () => {
    const r = mapGlMergeability({
      detailed_merge_status: "need_rebase",
      draft: false,
      has_conflicts: false,
      approvalsLeft: 0,
      pipelineStatus: "success",
      divergedCommitsCount: 2,
    });
    expect(r.notBehind).toBe(false);
  });
});
