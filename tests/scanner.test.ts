import { describe, test, expect } from "bun:test";
import { parseRemoteUrl, type RepoInfo } from "../lib/scanner";

describe("parseRemoteUrl", () => {
  test("parses SSH GitHub remote", () => {
    const result = parseRemoteUrl("git@github.com:owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH GitHub remote without .git suffix", () => {
    const result = parseRemoteUrl("git@github.com:owner/repo");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses HTTPS GitHub remote", () => {
    const result = parseRemoteUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses HTTPS GitHub remote without .git suffix", () => {
    const result = parseRemoteUrl("https://github.com/owner/repo");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH GitLab remote", () => {
    const result = parseRemoteUrl("git@gitlab.com:myorg/myrepo.git");
    expect(result).toEqual({
      host: "gitlab.com",
      owner: "myorg",
      repo: "myrepo",
    });
  });

  test("parses HTTPS with subdomain", () => {
    const result = parseRemoteUrl("https://github.example.com/myorg/myrepo.git");
    expect(result).toEqual({
      host: "github.example.com",
      owner: "myorg",
      repo: "myrepo",
    });
  });

  test("returns null for invalid URL", () => {
    const result = parseRemoteUrl("not-a-valid-url");
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    const result = parseRemoteUrl("");
    expect(result).toBeNull();
  });

  test("returns null for URL with no path segments", () => {
    const result = parseRemoteUrl("https://github.com/");
    expect(result).toBeNull();
  });

  test("handles SSH remote with hyphenated names", () => {
    const result = parseRemoteUrl("git@github.com:my-org/my-repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "my-org",
      repo: "my-repo",
    });
  });

  test("strips userinfo from HTTPS remote", () => {
    const result = parseRemoteUrl("https://adamcongdon@github.com/owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  test("strips embedded token from HTTPS remote", () => {
    const result = parseRemoteUrl("https://gho_FAKETOKEN@github.com/owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("shouldSkipDirectory", () => {
  test("skips node_modules", async () => {
    const { shouldSkipDirectory } = await import("../lib/scanner");
    expect(shouldSkipDirectory("node_modules")).toBe(true);
  });

  test("skips .cache", async () => {
    const { shouldSkipDirectory } = await import("../lib/scanner");
    expect(shouldSkipDirectory(".cache")).toBe(true);
  });

  test("skips Library", async () => {
    const { shouldSkipDirectory } = await import("../lib/scanner");
    expect(shouldSkipDirectory("Library")).toBe(true);
  });

  test("skips vendor", async () => {
    const { shouldSkipDirectory } = await import("../lib/scanner");
    expect(shouldSkipDirectory("vendor")).toBe(true);
  });

  test("does not skip src", async () => {
    const { shouldSkipDirectory } = await import("../lib/scanner");
    expect(shouldSkipDirectory("src")).toBe(false);
  });

  test("does not skip my-project", async () => {
    const { shouldSkipDirectory } = await import("../lib/scanner");
    expect(shouldSkipDirectory("my-project")).toBe(false);
  });
});
