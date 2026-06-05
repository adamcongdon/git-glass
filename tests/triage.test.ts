import { describe, test, expect, mock } from "bun:test";
import { parseTriageResponse, buildTriagePrompt, type RepoCandidate, type Priority, type Component, type Effort } from "../lib/triage";

describe("parseTriageResponse", () => {
  test("parses valid JSON response", () => {
    const raw = JSON.stringify({
      title: "Fix login button",
      body: "The login button does not work on mobile",
      type: "bug",
    });
    const result = parseTriageResponse(raw);
    expect(result).toEqual({
      title: "Fix login button",
      body: "The login button does not work on mobile",
      type: "bug",
      suggestedRepo: null,
      priority: "P2-medium",
      component: "general",
      priorityRationale: "",
      rootCause: "",
      suggestedFix: "",
      effort: "M",
    });
  });

  test("parses JSON wrapped in markdown code fence", () => {
    const raw = "```json\n{\"title\":\"Add dark mode\",\"body\":\"Users want dark mode\",\"type\":\"feature\"}\n```";
    const result = parseTriageResponse(raw);
    expect(result).toEqual({
      title: "Add dark mode",
      body: "Users want dark mode",
      type: "feature",
      suggestedRepo: null,
      priority: "P2-medium",
      component: "general",
      priorityRationale: "",
      rootCause: "",
      suggestedFix: "",
      effort: "M",
    });
  });

  test("parses JSON wrapped in plain code fence", () => {
    const raw = "```\n{\"title\":\"Question about API\",\"body\":\"How do I authenticate?\",\"type\":\"question\"}\n```";
    const result = parseTriageResponse(raw);
    expect(result).toEqual({
      title: "Question about API",
      body: "How do I authenticate?",
      type: "question",
      suggestedRepo: null,
      priority: "P2-medium",
      component: "general",
      priorityRationale: "",
      rootCause: "",
      suggestedFix: "",
      effort: "M",
    });
  });

  test("falls back gracefully on invalid JSON", () => {
    const raw = "This is not JSON at all";
    const result = parseTriageResponse(raw);
    expect(result).toEqual({
      title: "",
      body: raw,
      type: "question",
      suggestedRepo: null,
      priority: "P2-medium",
      component: "general",
      priorityRationale: "",
      rootCause: "",
      suggestedFix: "",
      effort: "M",
    });
  });

  test("falls back on empty string", () => {
    const result = parseTriageResponse("");
    expect(result.type).toBe("question");
    expect(result.title).toBe("");
    expect(result.priority).toBe("P2-medium");
    expect(result.component).toBe("general");
    expect(result.effort).toBe("M");
  });

  test("normalizes type 'feature' to valid type", () => {
    const raw = JSON.stringify({ title: "Add feature", body: "Details", type: "feature" });
    const result = parseTriageResponse(raw);
    expect(["bug", "feature", "question"]).toContain(result.type);
  });

  test("falls back if type is invalid", () => {
    const raw = JSON.stringify({ title: "Test", body: "Details", type: "invalid-type" });
    const result = parseTriageResponse(raw);
    expect(result.type).toBe("question");
  });

  test("handles partial JSON with missing fields", () => {
    const raw = JSON.stringify({ title: "Only title" });
    const result = parseTriageResponse(raw);
    expect(result.title).toBe("Only title");
    expect(result.type).toBe("question");
    expect(result.priority).toBe("P2-medium");
    expect(result.component).toBe("general");
    expect(result.effort).toBe("M");
  });

  test("preserves original text in <details> block when provided", () => {
    const raw = JSON.stringify({
      title: "Crash on startup",
      body: "App crashes when launching from cold start",
      type: "bug",
    });
    const originalText = "ERROR: foo\n  at bar:123\n  at baz:456";
    const result = parseTriageResponse(raw, originalText);
    expect(result.title).toBe("Crash on startup");
    expect(result.body).toContain("App crashes when launching from cold start");
    expect(result.body).toContain("<details>");
    expect(result.body).toContain("<summary>Original feedback</summary>");
    expect(result.body).toContain("ERROR: foo");
    expect(result.body).toContain("at bar:123");
    expect(result.body).toContain("at baz:456");
    expect(result.body).toContain("</details>");
  });

  test("preserves original text on JSON parse failure", () => {
    const raw = "not json";
    const originalText = "User typed this raw feedback that we want to keep";
    const result = parseTriageResponse(raw, originalText);
    expect(result.body).toContain("not json");
    expect(result.body).toContain("<details>");
    expect(result.body).toContain("<summary>Original feedback</summary>");
    expect(result.body).toContain("User typed this raw feedback that we want to keep");
    expect(result.body).toContain("</details>");
  });

  test("escapes HTML in original text", () => {
    const raw = JSON.stringify({
      title: "T",
      body: "B",
      type: "bug",
    });
    const originalText = "</details><script>alert(1)</script>";
    const result = parseTriageResponse(raw, originalText);
    expect(result.body).toContain("&lt;/details&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.body).not.toContain("</details><script>alert(1)</script>");
  });
});

describe("parseTriageResponse — new extended fields", () => {
  test("parses all 6 new fields when present", () => {
    const raw = JSON.stringify({
      title: "Auth broken",
      body: "Login fails for SSO users",
      type: "bug",
      priority: "P1-high",
      component: "auth",
      priority_rationale: "Blocking all SSO users",
      root_cause: "lib/auth.ts line 42 — token expiry not checked",
      suggested_fix: "Add token expiry validation in verifyToken()",
      effort: "S",
    });
    const result = parseTriageResponse(raw);
    expect(result.priority).toBe("P1-high");
    expect(result.component).toBe("auth");
    expect(result.priorityRationale).toBe("Blocking all SSO users");
    expect(result.rootCause).toBe("lib/auth.ts line 42 — token expiry not checked");
    expect(result.suggestedFix).toBe("Add token expiry validation in verifyToken()");
    expect(result.effort).toBe("S");
  });

  test("invalid priority falls back to P2-medium", () => {
    const raw = JSON.stringify({ title: "T", body: "B", type: "bug", priority: "URGENT" });
    const result = parseTriageResponse(raw);
    expect(result.priority).toBe("P2-medium");
  });

  test("invalid component falls back to general", () => {
    const raw = JSON.stringify({ title: "T", body: "B", type: "bug", component: "unknown-thing" });
    const result = parseTriageResponse(raw);
    expect(result.component).toBe("general");
  });

  test("invalid effort falls back to M", () => {
    const raw = JSON.stringify({ title: "T", body: "B", type: "bug", effort: "HUGE" });
    const result = parseTriageResponse(raw);
    expect(result.effort).toBe("M");
  });

  test("malformed JSON returns all new fields with defaults", () => {
    const result = parseTriageResponse("not json {{");
    expect(result.priority).toBe("P2-medium");
    expect(result.component).toBe("general");
    expect(result.priorityRationale).toBe("");
    expect(result.rootCause).toBe("");
    expect(result.suggestedFix).toBe("");
    expect(result.effort).toBe("M");
  });

  test("all valid priority values are accepted", () => {
    for (const p of ["P0-critical", "P1-high", "P2-medium", "P3-low"]) {
      const raw = JSON.stringify({ title: "T", body: "B", type: "bug", priority: p });
      expect(parseTriageResponse(raw).priority).toBe(p as Priority);
    }
  });

  test("all valid component values are accepted", () => {
    for (const c of ["auth", "ui", "analytics", "vault-estimator", "deployment", "database", "performance", "general"]) {
      const raw = JSON.stringify({ title: "T", body: "B", type: "bug", component: c });
      expect(parseTriageResponse(raw).component).toBe(c as Component);
    }
  });

  test("all valid effort values are accepted", () => {
    for (const e of ["XS", "S", "M", "L", "XL"]) {
      const raw = JSON.stringify({ title: "T", body: "B", type: "bug", effort: e });
      expect(parseTriageResponse(raw).effort).toBe(e as Effort);
    }
  });

  test("non-string priority_rationale falls back to empty string", () => {
    const raw = JSON.stringify({ title: "T", body: "B", type: "bug", priority_rationale: 42 });
    const result = parseTriageResponse(raw);
    expect(result.priorityRationale).toBe("");
  });
});

describe("buildTriagePrompt", () => {
  test("returns system and user messages", () => {
    const { system, user } = buildTriagePrompt("The app crashes on startup");
    expect(system).toContain("JSON");
    expect(system).toContain("Do NOT wrap in backticks");
    expect(user).toContain("The app crashes on startup");
  });

  test("system prompt contains title, body, type fields", () => {
    const { system } = buildTriagePrompt("test");
    expect(system).toContain("title");
    expect(system).toContain("body");
    expect(system).toContain("type");
  });

  test("system prompt specifies valid type values", () => {
    const { system } = buildTriagePrompt("test");
    expect(system).toContain("bug");
    expect(system).toContain("feature");
    expect(system).toContain("question");
  });

  test("system prompt contains all priority values", () => {
    const { system } = buildTriagePrompt("test");
    expect(system).toContain("P0-critical");
    expect(system).toContain("P1-high");
    expect(system).toContain("P2-medium");
    expect(system).toContain("P3-low");
  });

  test("system prompt contains priority, component, effort fields", () => {
    const { system } = buildTriagePrompt("test");
    expect(system).toContain("priority");
    expect(system).toContain("component");
    expect(system).toContain("effort");
  });

  test("system prompt contains component values", () => {
    const { system } = buildTriagePrompt("test");
    expect(system).toContain("auth");
    expect(system).toContain("ui");
    expect(system).toContain("general");
  });

  test("system prompt contains effort values", () => {
    const { system } = buildTriagePrompt("test");
    expect(system).toContain("XS");
    expect(system).toContain("XL");
  });
});

describe("parseTriageResponse — suggestedRepo field", () => {
  test("returns suggestedRepo: null when field is absent in JSON", () => {
    const raw = JSON.stringify({ title: "Test", body: "Details", type: "bug" });
    const result = parseTriageResponse(raw);
    expect(result.suggestedRepo).toBeNull();
  });

  test("returns the string when suggested_repo is present", () => {
    const raw = JSON.stringify({
      title: "Test",
      body: "Details",
      type: "bug",
      suggested_repo: "owner/repo",
    });
    const result = parseTriageResponse(raw);
    expect(result.suggestedRepo).toBe("owner/repo");
  });

  test("returns suggestedRepo: null when suggested_repo is explicitly null", () => {
    const raw = JSON.stringify({
      title: "Test",
      body: "Details",
      type: "bug",
      suggested_repo: null,
    });
    const result = parseTriageResponse(raw);
    expect(result.suggestedRepo).toBeNull();
  });
});

describe("buildTriagePrompt — RepoCandidate list", () => {
  test("empty repos list does NOT include Candidate Repositories section", () => {
    const { system } = buildTriagePrompt("test", []);
    expect(system).not.toContain("Candidate Repositories");
  });

  test("non-empty repos list includes the repo name in system prompt", () => {
    const repos: RepoCandidate[] = [{ name: "owner/repo", host: "github.com" }];
    const { system } = buildTriagePrompt("test", repos);
    expect(system).toContain("owner/repo");
    expect(system).toContain("Candidate Repositories");
  });

  test("instructs the model about suggested_repo field rules", () => {
    const repos: RepoCandidate[] = [{ name: "owner/repo", host: "github.com" }];
    const { system } = buildTriagePrompt("test", repos);
    expect(system).toContain("suggested_repo");
  });

  test("no-repos-arg call produces byte-identical output to original no-repos call", () => {
    const noArg = buildTriagePrompt("hello world");
    const emptyArg = buildTriagePrompt("hello world", []);
    // empty list should behave exactly like no arg
    expect(emptyArg.system).toBe(noArg.system);
    expect(emptyArg.user).toBe(noArg.user);
  });
});
