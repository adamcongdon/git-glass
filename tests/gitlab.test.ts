import { describe, test, expect, mock, spyOn } from "bun:test";
import { mapGitLabError, buildIssuePayload, type IssueOptions } from "../lib/gitlab";

describe("mapGitLabError", () => {
  test("maps 401 to invalid token message", () => {
    const err = mapGitLabError(401, "Unauthorized");
    expect(err.code).toBe("INVALID_TOKEN");
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/token/i);
  });

  test("maps 403 to permissions error", () => {
    const err = mapGitLabError(403, "Forbidden");
    expect(err.code).toBe("INSUFFICIENT_PERMISSIONS");
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/permission/i);
  });

  test("maps 404 to not found error", () => {
    const err = mapGitLabError(404, "Not Found");
    expect(err.code).toBe("REPO_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/not found/i);
  });

  test("maps 422 to validation error", () => {
    const err = mapGitLabError(422, "Unprocessable Entity");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.status).toBe(422);
    expect(err.message).toContain("Unprocessable Entity");
  });

  test("maps 500 to unavailable error", () => {
    const err = mapGitLabError(500, "Internal Server Error");
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/unavailable/i);
  });

  test("maps 503 to unavailable error", () => {
    const err = mapGitLabError(503, "Service Unavailable");
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/unavailable/i);
  });

  test("maps unknown status to generic error", () => {
    const err = mapGitLabError(418, "I'm a teapot");
    expect(err.code).toBe("GITLAB_ERROR");
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
    expect(payload.description).toBe("App crashes on startup");
    expect(typeof payload.labels).toBe("string");
    expect(payload.labels).toContain("bug");
  });

  test("builds feature payload with enhancement label", () => {
    const payload = buildIssuePayload({
      title: "Add dark mode",
      body: "Users want dark mode",
      type: "feature",
    });
    expect(typeof payload.labels).toBe("string");
    expect(payload.labels).toContain("enhancement");
  });

  test("builds question payload with question label", () => {
    const payload = buildIssuePayload({
      title: "How to auth",
      body: "How do I authenticate?",
      type: "question",
    });
    expect(typeof payload.labels).toBe("string");
    expect(payload.labels).toContain("question");
  });

  test("uses description field instead of body", () => {
    const payload = buildIssuePayload({
      title: "Test",
      body: "Details",
      type: "question",
    });
    expect(payload).toHaveProperty("title");
    expect(payload).toHaveProperty("description");
    expect(payload).not.toHaveProperty("body");
  });
});
