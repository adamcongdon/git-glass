import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isNewerTag,
  isRestartNeeded,
  getVersionInfo,
  planSelfUpdate,
  _resetVersionCacheForTesting,
} from "../lib/version";

describe("isRestartNeeded", () => {
  test("equal commits → false", () => {
    expect(isRestartNeeded("abc123", "abc123")).toBe(false);
  });

  test("differing commits → true", () => {
    expect(isRestartNeeded("abc123", "def456")).toBe(true);
  });

  test("null boot → false", () => {
    expect(isRestartNeeded(null, "def456")).toBe(false);
  });

  test("null disk → false", () => {
    expect(isRestartNeeded("abc123", null)).toBe(false);
  });

  test("both null → false", () => {
    expect(isRestartNeeded(null, null)).toBe(false);
  });
});

describe("isNewerTag", () => {
  test("patch bump: v0.1.1 newer than v0.1.0", () => {
    expect(isNewerTag("v0.1.1", "v0.1.0")).toBe(true);
  });

  test("equal versions are not newer", () => {
    expect(isNewerTag("v0.1.0", "v0.1.0")).toBe(false);
  });

  test("older latest is not newer than current", () => {
    expect(isNewerTag("v0.1.0", "v0.1.1")).toBe(false);
  });

  test("major bump: v2.0.0 newer than v1.9.9", () => {
    expect(isNewerTag("v2.0.0", "v1.9.9")).toBe(true);
  });

  test("minor bump: v0.2.0 newer than v0.1.99", () => {
    expect(isNewerTag("v0.2.0", "v0.1.99")).toBe(true);
  });

  test("without 'v' prefix: 0.1.1 newer than 0.1.0", () => {
    expect(isNewerTag("0.1.1", "0.1.0")).toBe(true);
  });

  test("without 'v' prefix: 0.1.0 not newer than 0.1.1", () => {
    expect(isNewerTag("0.1.0", "0.1.1")).toBe(false);
  });

  test("mixed prefixes: v0.1.1 newer than 0.1.0", () => {
    expect(isNewerTag("v0.1.1", "0.1.0")).toBe(true);
  });

  test("malformed latest returns false", () => {
    expect(isNewerTag("not-a-version", "v0.1.0")).toBe(false);
  });

  test("malformed current returns false", () => {
    expect(isNewerTag("v0.1.0", "garbage")).toBe(false);
  });

  test("empty string returns false", () => {
    expect(isNewerTag("", "v0.1.0")).toBe(false);
    expect(isNewerTag("v0.1.0", "")).toBe(false);
  });

  test("describe-format current with ahead-of-tag suffix: latest v0.1.1 newer than base v0.1.0", () => {
    // The caller (`getVersionInfo`) is responsible for stripping the suffix.
    // `isNewerTag` only parses the leading numeric triple, so a suffixed input
    // still parses the base correctly.
    expect(isNewerTag("v0.1.1", "v0.1.0-3-gabcdef")).toBe(true);
  });

  test("describe-format current with same base: latest v0.1.0 not newer than v0.1.0-3-gabcdef", () => {
    expect(isNewerTag("v0.1.0", "v0.1.0-3-gabcdef")).toBe(false);
  });

  test("multi-digit components compare numerically not lexically", () => {
    // "10" > "9" only numerically; lexical compare would fail this.
    expect(isNewerTag("v0.10.0", "v0.9.0")).toBe(true);
    expect(isNewerTag("v0.9.0", "v0.10.0")).toBe(false);
  });
});

// ── getVersionInfo cache + force behavior ────────────────────────────────

// We monkey-patch global fetch to count calls without hitting the network.
// Each test resets the in-process cache via the test-only helper.

describe("getVersionInfo cache + force", () => {
  let originalFetch: typeof fetch;
  let fetchCallCount: number;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCallCount = 0;
    _resetVersionCacheForTesting();
    globalThis.fetch = (async (_input: any, _init?: any) => {
      fetchCallCount++;
      // Return a minimal successful release payload
      return new Response(
        JSON.stringify({ tag_name: "v99.0.0", body: "Test release body" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetVersionCacheForTesting();
  });

  test("second call within TTL uses cache (fetch called once)", async () => {
    await getVersionInfo();
    await getVersionInfo();
    expect(fetchCallCount).toBe(1);
  });

  test("force=true bypasses cache (fetch called again)", async () => {
    await getVersionInfo();
    expect(fetchCallCount).toBe(1);
    await getVersionInfo(true);
    expect(fetchCallCount).toBe(2);
  });

  test("force=true still refreshes cache so next non-forced call is cached", async () => {
    await getVersionInfo(true);
    expect(fetchCallCount).toBe(1);
    await getVersionInfo(); // cache should now be fresh from the forced call
    expect(fetchCallCount).toBe(1);
  });

  test("changelog is captured from release body", async () => {
    const v = await getVersionInfo();
    expect(v.changelog).toBe("Test release body");
  });

  test("changelog is null when body is missing", async () => {
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(JSON.stringify({ tag_name: "v99.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const v = await getVersionInfo(true);
    expect(v.changelog).toBe(null);
  });

  test("changelog is null when body is empty string", async () => {
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(JSON.stringify({ tag_name: "v99.0.0", body: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const v = await getVersionInfo(true);
    expect(v.changelog).toBe(null);
  });

  test("changelog is truncated when body exceeds 1200 chars", async () => {
    const longBody = "x".repeat(2000);
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ tag_name: "v99.0.0", body: longBody }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const v = await getVersionInfo(true);
    expect(v.changelog).not.toBe(null);
    expect(v.changelog!.length).toBeLessThanOrEqual(1200 + "\n…[truncated]".length);
    expect(v.changelog!.endsWith("…[truncated]")).toBe(true);
  });

  test("changelog at exactly 1200 chars is not truncated", async () => {
    const body = "y".repeat(1200);
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ tag_name: "v99.0.0", body }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const v = await getVersionInfo(true);
    expect(v.changelog).toBe(body);
    expect(v.changelog!.endsWith("…[truncated]")).toBe(false);
  });

  test("changelog is null on fetch failure", async () => {
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const v = await getVersionInfo(true);
    expect(v.changelog).toBe(null);
    expect(v.latest).toBe(null);
  });
});

describe("planSelfUpdate", () => {
  // Baseline: on a release branch, strictly behind the release — the normal update path.
  const behind = {
    latestTag: "v0.5.0",
    tagCommit: "aaaa",
    headCommit: "bbbb",
    branch: "main",
    tagIsAncestorOfHead: false,
    headIsAncestorOfTag: true,
  };

  test("fast-forwards when HEAD is strictly behind the release", () => {
    const plan = planSelfUpdate(behind);
    expect(plan.status).toBe("fast-forward");
    expect(plan.message).toContain("v0.5.0");
  });

  test("already-current when HEAD already contains the release commit", () => {
    const plan = planSelfUpdate({ ...behind, tagIsAncestorOfHead: true, headIsAncestorOfTag: false });
    expect(plan.status).toBe("already-current");
  });

  test("cannot-fast-forward on a diverged branch, and names the branch", () => {
    const plan = planSelfUpdate({
      ...behind,
      branch: "dev",
      tagIsAncestorOfHead: false,
      headIsAncestorOfTag: false,
    });
    expect(plan.status).toBe("cannot-fast-forward");
    expect(plan.message).toContain('branch "dev"');
  });

  test("cannot-fast-forward reports 'detached HEAD' when branch resolves to HEAD", () => {
    const plan = planSelfUpdate({
      ...behind,
      branch: "HEAD",
      tagIsAncestorOfHead: false,
      headIsAncestorOfTag: false,
    });
    expect(plan.status).toBe("cannot-fast-forward");
    expect(plan.message).toContain("detached HEAD");
  });

  test("unavailable when the release check failed (no latest tag)", () => {
    const plan = planSelfUpdate({ ...behind, latestTag: null });
    expect(plan.status).toBe("unavailable");
  });

  test("unavailable when the release tag can't be resolved locally", () => {
    const plan = planSelfUpdate({ ...behind, tagCommit: null });
    expect(plan.status).toBe("unavailable");
    expect(plan.message).toContain("v0.5.0");
  });

  test("unavailable when HEAD can't be resolved", () => {
    const plan = planSelfUpdate({ ...behind, headCommit: null });
    expect(plan.status).toBe("unavailable");
  });

  test("already-current takes precedence over a possible fast-forward", () => {
    // Defensive: if both ancestor checks are somehow true (HEAD === tag), treat as current.
    const plan = planSelfUpdate({ ...behind, tagIsAncestorOfHead: true, headIsAncestorOfTag: true });
    expect(plan.status).toBe("already-current");
  });
});
