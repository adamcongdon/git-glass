import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Parse index.ts and list mutating Hono routes whose handler body does not
 * call sameOriginGuard before the first return. Keeps FEATURE_MAP's claim
 * that mutating routes use the guard enforceable as a test.
 */
export function unguardedMutatingRoutes(source: string): string[] {
  const routeRe = /app\.(post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const unguarded: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = routeRe.exec(source)) !== null) {
    const method = match[1]!.toUpperCase();
    const path = match[2]!;
    const start = match.index + match[0].length;
    // Walk until the matching closing of this app.* call: find the handler
    // body and require sameOriginGuard before any return.
    const slice = source.slice(start, start + 800);
    const guardAt = slice.search(/\bsameOriginGuard\s*\(/);
    const returnAt = slice.search(/\breturn\b/);
    if (guardAt < 0 || (returnAt >= 0 && returnAt < guardAt)) {
      unguarded.push(`${method} ${path}`);
    }
  }
  return unguarded;
}

describe("mutating routes CSRF", () => {
  test("every POST/PUT/PATCH/DELETE handler in index.ts calls sameOriginGuard before returning", () => {
    const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    const bad = unguardedMutatingRoutes(source);
    expect(bad).toEqual([]);
  });

  test("unguardedMutatingRoutes flags a handler that returns before the guard", () => {
    const sample = `
app.post("/api/evil", async (c) => {
  return c.json({ ok: true });
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;
});
`;
    expect(unguardedMutatingRoutes(sample)).toEqual(["POST /api/evil"]);
  });

  test("unguardedMutatingRoutes accepts a guarded handler", () => {
    const sample = `
app.put("/api/ok", async (c) => {
  const csrf = sameOriginGuard(c);
  if (csrf) return csrf;
  return c.json({ ok: true });
});
`;
    expect(unguardedMutatingRoutes(sample)).toEqual([]);
  });
});
