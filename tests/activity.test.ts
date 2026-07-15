import { describe, test, expect } from "bun:test";
import {
  parseActivityWindow,
  clearActivityCache,
  ACTIVITY_CACHE_TTL_MS,
} from "../lib/activity";

describe("parseActivityWindow", () => {
  test("defaults to 1y", () => {
    expect(parseActivityWindow(undefined)).toBe("1y");
    expect(parseActivityWindow("")).toBe("1y");
  });

  test("accepts 7d 30d 90d 1y", () => {
    expect(parseActivityWindow("7d")).toBe("7d");
    expect(parseActivityWindow("30d")).toBe("30d");
    expect(parseActivityWindow("90d")).toBe("90d");
    expect(parseActivityWindow("1y")).toBe("1y");
  });

  test("rejects invalid", () => {
    expect(() => parseActivityWindow("all")).toThrow();
    expect(() => parseActivityWindow("2y")).toThrow();
  });
});

describe("activity cache helpers", () => {
  test("clearActivityCache does not throw", () => {
    clearActivityCache();
    expect(ACTIVITY_CACHE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
