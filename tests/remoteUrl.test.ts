import { describe, test, expect } from "bun:test";
import { remoteToWebUrl } from "../lib/remoteUrl";

describe("remoteToWebUrl", () => {
  test("converts SSH GitHub URL with .git suffix", () => {
    expect(remoteToWebUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
  });

  test("converts SSH GitHub URL without .git suffix", () => {
    expect(remoteToWebUrl("git@github.com:owner/repo")).toBe("https://github.com/owner/repo");
  });

  test("preserves GitLab subgroup path in SSH URLs", () => {
    expect(remoteToWebUrl("git@gitlab.com:group/subgroup/repo.git")).toBe("https://gitlab.com/group/subgroup/repo");
  });

  test("converts ssh:// scheme URL", () => {
    expect(remoteToWebUrl("ssh://git@gitlab.example.com:2222/group/repo.git")).toBe("https://gitlab.example.com/group/repo");
  });

  test("passes through HTTPS URL and strips .git", () => {
    expect(remoteToWebUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });

  test("passes through plain HTTPS URL unchanged", () => {
    expect(remoteToWebUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });

  test("returns null for null input", () => {
    expect(remoteToWebUrl(null)).toBe(null);
  });

  test("returns null for empty string", () => {
    expect(remoteToWebUrl("")).toBe(null);
  });

  test("returns null for unparseable input", () => {
    expect(remoteToWebUrl("not-a-url")).toBe(null);
  });

  test("trims whitespace before parsing", () => {
    expect(remoteToWebUrl("  git@github.com:owner/repo.git  ")).toBe("https://github.com/owner/repo");
  });
});
