import { describe, test, expect } from "bun:test";
import { ConfigSchema, redactConfig } from "../lib/config";

describe("ConfigSchema", () => {
  test("validates with defaults", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scanPaths).toEqual([]);
      expect(result.data.scanDepth).toBe(3);
      expect(result.data.port).toBe(7777);
    }
  });

  test("validates full config", () => {
    const result = ConfigSchema.safeParse({
      scanPaths: ["/home/user/projects"],
      scanDepth: 5,
      port: 8080,
      github: {
        copilotAccount: "personal",
        defaultAccount: "personal",
        ownerAccounts: { veeam: "v-AdamC" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects scanDepth below 1", () => {
    const result = ConfigSchema.safeParse({ scanDepth: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects scanDepth above 10", () => {
    const result = ConfigSchema.safeParse({ scanDepth: 11 });
    expect(result.success).toBe(false);
  });

  test("rejects empty string in scanPaths", () => {
    const result = ConfigSchema.safeParse({ scanPaths: [""] });
    expect(result.success).toBe(false);
  });

  test("defaults github to empty object", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.github.ownerAccounts).toEqual({});
    }
  });

  test("ownerAccounts maps org names to account usernames", () => {
    const result = ConfigSchema.safeParse({
      github: { ownerAccounts: { veeam: "v-AdamC", myorg: "personal" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.github.ownerAccounts["veeam"]).toBe("v-AdamC");
    }
  });
});

describe("ConfigSchema new fields", () => {
  test("defaults ignoredRepos to empty array", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ignoredRepos).toEqual([]);
    }
  });

  test("accepts ignoredRepos array", () => {
    const result = ConfigSchema.safeParse({
      ignoredRepos: ["/Users/me/code/archived-project"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ignoredRepos).toContain("/Users/me/code/archived-project");
    }
  });

  test("defaults repos.autoRefreshSec to 0", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repos.autoRefreshSec).toBe(0);
    }
  });

  test("accepts repos.autoRefreshSec in valid range", () => {
    const result = ConfigSchema.safeParse({ repos: { autoRefreshSec: 60 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repos.autoRefreshSec).toBe(60);
    }
  });

  test("rejects repos.autoRefreshSec above 1800", () => {
    const result = ConfigSchema.safeParse({ repos: { autoRefreshSec: 3600 } });
    expect(result.success).toBe(false);
  });

  test("rejects repos.autoRefreshSec below 0", () => {
    const result = ConfigSchema.safeParse({ repos: { autoRefreshSec: -1 } });
    expect(result.success).toBe(false);
  });
});

describe("redactConfig", () => {
  test("passes through account config", () => {
    const config = {
      scanPaths: [],
      scanDepth: 3,
      port: 7777,
      github: {
        copilotAccount: "personal",
        defaultAccount: "personal",
        ownerAccounts: { veeam: "v-AdamC" },
      },
    };
    const redacted = redactConfig(config);
    expect(redacted.github.copilotAccount).toBe("personal");
    expect(redacted.github.defaultAccount).toBe("personal");
    expect(redacted.github.ownerAccounts["veeam"]).toBe("v-AdamC");
  });

  test("handles missing github config gracefully", () => {
    const config = { scanPaths: [], scanDepth: 3, port: 7777, github: { ownerAccounts: {} } };
    const redacted = redactConfig(config);
    expect(redacted.github.copilotAccount).toBeUndefined();
    expect(redacted.github.defaultAccount).toBeUndefined();
    expect(redacted.github.ownerAccounts).toEqual({});
  });

  test("does not mutate original config", () => {
    const config = {
      scanPaths: [],
      scanDepth: 3,
      port: 7777,
      github: { copilotAccount: "me", ownerAccounts: {} },
    };
    const originalAccount = config.github.copilotAccount;
    redactConfig(config);
    expect(config.github.copilotAccount).toBe(originalAccount);
  });

  test("exposes ignoredRepos in redacted output", () => {
    const config = {
      scanPaths: [],
      scanDepth: 3,
      port: 7777,
      ignoredRepos: ["/Users/me/code/old-project"],
    };
    const redacted = redactConfig(config);
    expect(redacted.ignoredRepos).toEqual(["/Users/me/code/old-project"]);
  });

  test("exposes repos.autoRefreshSec in redacted output", () => {
    const config = {
      scanPaths: [],
      scanDepth: 3,
      port: 7777,
      repos: { autoRefreshSec: 30 },
    };
    const redacted = redactConfig(config);
    expect(redacted.repos.autoRefreshSec).toBe(30);
  });

  test("defaults ignoredRepos and repos when missing", () => {
    const config = { scanPaths: [], scanDepth: 3, port: 7777 };
    const redacted = redactConfig(config);
    expect(redacted.ignoredRepos).toEqual([]);
    expect(redacted.repos.autoRefreshSec).toBe(0);
  });
});
