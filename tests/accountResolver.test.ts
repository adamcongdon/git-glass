import { describe, it, expect } from "bun:test";
import { resolveAccountForRemote } from "../lib/accountResolver";
import type { Config } from "../lib/config";
import { ConfigSchema } from "../lib/config";

function makeConfig(overrides: Partial<Config["github"]> = {}, gitlabTokens: Record<string, string> = {}): Config {
  return ConfigSchema.parse({
    github: overrides,
    gitlab: { tokens: gitlabTokens },
  });
}

describe("resolveAccountForRemote", () => {
  it("returns ownerAccounts match for github remote", () => {
    const config = makeConfig({ ownerAccounts: { veeam: "v-AdamC" } });
    const result = resolveAccountForRemote("git@github.com:veeam/repo.git", config, ["v-AdamC", "other"]);
    expect(result.type).toBe("github");
    expect(result.resolved).toBe(true);
    expect(result.account).toBe("v-AdamC");
    expect(result.availableAccounts).toEqual(["v-AdamC", "other"]);
  });

  it("falls back to defaultAccount when no ownerAccounts match", () => {
    const config = makeConfig({ defaultAccount: "myDefault" });
    const result = resolveAccountForRemote("https://github.com/someorg/repo.git", config, ["myDefault"]);
    expect(result.type).toBe("github");
    expect(result.resolved).toBe(true);
    expect(result.account).toBe("myDefault");
  });

  it("returns resolved: false when neither ownerAccounts nor defaultAccount set", () => {
    const config = makeConfig({});
    const result = resolveAccountForRemote("git@github.com:owner/repo.git", config, []);
    expect(result.type).toBe("github");
    expect(result.resolved).toBe(false);
    expect(result.account).toBeUndefined();
  });

  it("lower-cases owner when looking up ownerAccounts", () => {
    const config = makeConfig({ ownerAccounts: { veeam: "v-AdamC" } });
    const result = resolveAccountForRemote("git@github.com:Veeam/Repo.git", config, []);
    expect(result.account).toBe("v-AdamC");
  });

  it("returns gitlab type with hasToken: true when token exists", () => {
    const config = makeConfig({}, { "gitlab.veeam.com": "glpat-xxx" });
    const result = resolveAccountForRemote("git@gitlab.veeam.com:group/repo.git", config, []);
    expect(result.type).toBe("gitlab");
    expect(result.hasToken).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.host).toBe("gitlab.veeam.com");
    expect(result.availableAccounts).toEqual([]);
  });

  it("returns gitlab type with hasToken: false when no token", () => {
    const config = makeConfig({}, {});
    const result = resolveAccountForRemote("https://gitlab.veeam.com/group/repo.git", config, []);
    expect(result.type).toBe("gitlab");
    expect(result.hasToken).toBe(false);
    expect(result.resolved).toBe(false);
  });

  it("returns unknown type for unparseable URL", () => {
    const config = makeConfig({});
    const result = resolveAccountForRemote("not-a-url", config, ["someAccount"]);
    expect(result.type).toBe("unknown");
    expect(result.resolved).toBe(false);
    expect(result.availableAccounts).toEqual(["someAccount"]);
  });

  it("forwards availableAccounts on unknown resolution", () => {
    const config = makeConfig({});
    const accts = ["a", "b"];
    const result = resolveAccountForRemote("not-a-url", config, accts);
    expect(result.availableAccounts).toEqual(accts);
  });
});
