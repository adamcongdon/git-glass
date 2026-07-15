/**
 * CSRF guard for mutating routes.
 *
 * When Glass is bound to loopback only, attackers still need same-origin
 * protection (cross-site form posts with text/plain). When bound to LAN
 * (0.0.0.0), Origin must match the request Host — not merely "is loopback".
 */

export type HeaderReader = {
  req: { header: (name: string) => string | undefined };
};

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** Host header may be `name`, `name:port`, or `[ipv6]:port`. */
export function parseHostHeader(hostHeader: string | undefined): {
  hostname: string;
  host: string;
} | null {
  if (!hostHeader) return null;
  const raw = hostHeader.trim();
  if (!raw) return null;
  try {
    // URL parser needs a scheme; Host already excludes path.
    const u = new URL("http://" + raw);
    return { hostname: u.hostname, host: u.host };
  } catch {
    return null;
  }
}

/**
 * Returns a 403 Response when Origin/Referer is present and not same-origin
 * with the request Host. Missing both Origin and Referer → allow (CLI).
 */
export function sameOriginGuard(
  c: HeaderReader,
  errorResponse: (code: string, message: string, status: number) => Response,
): Response | null {
  const reqHost = parseHostHeader(c.req.header("host"));

  const checkUrl = (raw: string | undefined): boolean | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (reqHost) {
        // Strict same-origin: scheme host:port matches Host header
        if (u.host === reqHost.host) return true;
        // Loopback aliases: localhost ↔ 127.0.0.1 ↔ ::1 on same port
        if (isLoopbackHost(u.hostname) && isLoopbackHost(reqHost.hostname)) {
          const oPort = u.port || (u.protocol === "https:" ? "443" : "80");
          const hPort =
            reqHost.host.includes("]:")
              ? reqHost.host.split("]:")[1]
              : reqHost.host.includes(":")
                ? reqHost.host.split(":").pop()!
                : "80";
          // Compare ports when both specified in Host; default http 80 rarely used here
          const reqPort = reqHost.host.match(/:(\d+)$/)?.[1] ?? "";
          if (!reqPort || oPort === reqPort) return true;
        }
        return false;
      }
      // No Host header (unusual) — fall back to loopback-only allow
      return isLoopbackHost(u.hostname);
    } catch {
      return false;
    }
  };

  const originOk = checkUrl(c.req.header("origin"));
  if (originOk === false) {
    return errorResponse("CSRF_REJECTED", "Cross-origin request rejected", 403);
  }
  if (originOk === true) return null;

  const refererOk = checkUrl(c.req.header("referer"));
  if (refererOk === false) {
    return errorResponse("CSRF_REJECTED", "Cross-origin request rejected", 403);
  }
  return null;
}
