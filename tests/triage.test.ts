import { describe, test, expect, mock } from "bun:test";
import { parseTriageResponse, buildTriagePrompt, type RepoCandidate } from "../lib/triage";

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
    });
  });

  test("falls back on empty string", () => {
    const result = parseTriageResponse("");
    expect(result.type).toBe("question");
    expect(result.title).toBe("");
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
