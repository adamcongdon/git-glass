import { describe, expect, test } from "bun:test";
import { app } from "../index";

describe("GET /api/health", () => {
  test("returns { ok: true }", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /", () => {
  test("serves the Git Glass shell", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Git Glass</title>");
  });
});
