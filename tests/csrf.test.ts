import { describe, test, expect } from "bun:test";
import { isLoopbackHost, parseHostHeader, sameOriginGuard } from "../lib/csrf";

function err(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message, status } }), { status });
}

function mockReq(headers: Record<string, string | undefined>) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    },
  };
}

describe("isLoopbackHost", () => {
  test("recognizes loopback names", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});

describe("parseHostHeader", () => {
  test("parses host:port", () => {
    expect(parseHostHeader("192.168.1.5:7777")).toEqual({
      hostname: "192.168.1.5",
      host: "192.168.1.5:7777",
    });
  });
});

describe("sameOriginGuard", () => {
  test("allows missing Origin and Referer (CLI)", () => {
    const r = sameOriginGuard(mockReq({ host: "127.0.0.1:7777" }), err);
    expect(r).toBeNull();
  });

  test("allows loopback Origin on loopback Host", () => {
    const r = sameOriginGuard(
      mockReq({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }),
      err,
    );
    expect(r).toBeNull();
  });

  test("allows localhost Origin when Host is 127.0.0.1", () => {
    const r = sameOriginGuard(
      mockReq({ host: "127.0.0.1:7777", origin: "http://localhost:7777" }),
      err,
    );
    expect(r).toBeNull();
  });

  test("allows LAN Origin matching Host", () => {
    const r = sameOriginGuard(
      mockReq({ host: "192.168.1.42:7777", origin: "http://192.168.1.42:7777" }),
      err,
    );
    expect(r).toBeNull();
  });

  test("rejects evil.com Origin against LAN Host", async () => {
    const r = sameOriginGuard(
      mockReq({ host: "192.168.1.42:7777", origin: "https://evil.com" }),
      err,
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });

  test("rejects mismatched LAN Origin", async () => {
    const r = sameOriginGuard(
      mockReq({ host: "192.168.1.42:7777", origin: "http://10.0.0.5:7777" }),
      err,
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });
});
