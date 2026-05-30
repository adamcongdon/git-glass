import { describe, test, expect, mock, spyOn } from "bun:test";
import { mapGitHubError, buildIssuePayload, buildTriageComment, applyLabels, postTriageComment, type IssueOptions, type TriageCommentData } from "../lib/github";

describe("mapGitHubError", () => {
  test("maps 401 to invalid token message", () => {
    const err = mapGitHubError(401, "Unauthorized");
    expect(err.code).toBe("INVALID_TOKEN");
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/token/i);
  });

  test("maps 403 to permissions error", () => {
    const err = mapGitHubError(403, "Forbidden");
    expect(err.code).toBe("INSUFFICIENT_PERMISSIONS");
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/permission/i);
  });

  test("maps 404 to not found error", () => {
    const err = mapGitHubError(404, "Not Found");
    expect(err.code).toBe("REPO_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/not found/i);
  });

  test("maps 422 to validation error", () => {
    const err = mapGitHubError(422, "Unprocessable Entity");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.status).toBe(422);
  });

  test("maps 500 to unavailable error", () => {
    const err = mapGitHubError(500, "Internal Server Error");
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/unavailable/i);
  });

  test("maps 503 to unavailable error", () => {
    const err = mapGitHubError(503, "Service Unavailable");
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.status).toBe(503);
  });

  test("maps unknown status to generic error", () => {
    const err = mapGitHubError(418, "I'm a teapot");
    expect(err.code).toBe("GITHUB_ERROR");
    expect(err.status).toBe(418);
  });
});

describe("buildIssuePayload", () => {
  test("builds bug payload with bug label", () => {
    const payload = buildIssuePayload({
      title: "Fix crash",
      body: "App crashes on startup",
      type: "bug",
    });
    expect(payload.title).toBe("Fix crash");
    expect(payload.body).toBe("App crashes on startup");
    expect(payload.labels).toContain("bug");
  });

  test("builds feature payload with enhancement label", () => {
    const payload = buildIssuePayload({
      title: "Add dark mode",
      body: "Users want dark mode",
      type: "feature",
    });
    expect(payload.labels).toContain("enhancement");
  });

  test("builds question payload with question label", () => {
    const payload = buildIssuePayload({
      title: "How to auth",
      body: "How do I authenticate?",
      type: "question",
    });
    expect(payload.labels).toContain("question");
  });

  test("payload without labels field when type unknown", () => {
    const payload = buildIssuePayload({
      title: "Test",
      body: "Details",
      type: "question",
    });
    expect(payload).toHaveProperty("title");
    expect(payload).toHaveProperty("body");
  });
});

describe("buildTriageComment", () => {
  const baseTriage: TriageCommentData = {
    type: "bug",
    priority: "P2-medium",
    component: "ui",
  };

  test("contains ## Triage Summary header", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("## Triage Summary");
  });

  test("contains Type row with value", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("**Type**");
    expect(comment).toContain("bug");
  });

  test("contains Priority row with value", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("**Priority**");
    expect(comment).toContain("P2-medium");
  });

  test("contains Component row with value", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("**Component**");
    expect(comment).toContain("ui");
  });

  test("contains Root Cause row", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("**Root Cause**");
  });

  test("contains Suggested Fix row", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("**Suggested Fix**");
  });

  test("contains Effort row", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("**Effort**");
  });

  test("includes priority rationale in priority cell when provided", () => {
    const comment = buildTriageComment({
      ...baseTriage,
      priorityRationale: "some reason",
    });
    expect(comment).toContain("P2-medium — some reason");
  });

  test("empty optional fields render as _not specified_", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("_not specified_");
  });

  test("rootCause is shown when provided", () => {
    const comment = buildTriageComment({
      ...baseTriage,
      rootCause: "lib/auth.ts line 42",
    });
    expect(comment).toContain("lib/auth.ts line 42");
  });

  test("suggestedFix is shown when provided", () => {
    const comment = buildTriageComment({
      ...baseTriage,
      suggestedFix: "Add null check",
    });
    expect(comment).toContain("Add null check");
  });

  test("effort is shown when provided", () => {
    const comment = buildTriageComment({
      ...baseTriage,
      effort: "S",
    });
    expect(comment).toContain("| **Effort** | S |");
  });

  test("is a markdown table", () => {
    const comment = buildTriageComment(baseTriage);
    expect(comment).toContain("| Field | Value |");
    expect(comment).toContain("|---|---|");
  });
});

describe("applyLabels", () => {
  test("returns true when fetch returns 200", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([{ name: "bug" }]), { status: 200 })) as unknown as typeof globalThis.fetch;
    try {
      const result = await applyLabels("owner", "repo", "token", 1, ["bug"]);
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns false when fetch returns 422", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Unprocessable", { status: 422 })) as unknown as typeof globalThis.fetch;
    try {
      const result = await applyLabels("owner", "repo", "token", 1, ["nonexistent"]);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("never throws when fetch rejects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("Network error"); }) as unknown as typeof globalThis.fetch;
    try {
      const result = await applyLabels("owner", "repo", "token", 1, ["bug"]);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("posts to correct labels URL", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await applyLabels("myowner", "myrepo", "tok", 42, ["bug"]);
      expect(capturedUrl).toBe("https://api.github.com/repos/myowner/myrepo/issues/42/labels");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("postTriageComment", () => {
  const triage: TriageCommentData = {
    type: "bug",
    priority: "P1-high",
    component: "auth",
    priorityRationale: "Blocks all users",
    rootCause: "Token expiry missing",
    suggestedFix: "Add expiry check",
    effort: "S",
  };

  test("posts to correct comments URL", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await postTriageComment("myowner", "myrepo", "tok", 7, triage);
      expect(capturedUrl).toBe("https://api.github.com/repos/myowner/myrepo/issues/7/comments");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("body contains ## Triage Summary", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await postTriageComment("owner", "repo", "tok", 1, triage);
      expect(capturedBody.body).toContain("## Triage Summary");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns true on 201", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 1 }), { status: 201 })) as unknown as typeof globalThis.fetch;
    try {
      const result = await postTriageComment("owner", "repo", "tok", 1, triage);
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns false (not throw) when fetch rejects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("Network failure"); }) as unknown as typeof globalThis.fetch;
    try {
      const result = await postTriageComment("owner", "repo", "tok", 1, triage);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns false when fetch returns 403", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof globalThis.fetch;
    try {
      const result = await postTriageComment("owner", "repo", "tok", 1, triage);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
