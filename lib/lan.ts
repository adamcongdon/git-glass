import { networkInterfaces } from "os";

/** IPv4 addresses on non-internal interfaces (LAN / Wi‑Fi / Ethernet). */
export function listLanIPv4(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      const family = net.family;
      const isV4 = family === "IPv4" || family === 4;
      if (isV4 && !net.internal && net.address) {
        ips.push(net.address);
      }
    }
  }
  return [...new Set(ips)];
}

export function formatListenUrls(hostname: string, port: number): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  if (hostname === "0.0.0.0" || hostname === "::") {
    for (const ip of listLanIPv4()) {
      urls.push(`http://${ip}:${port}`);
    }
  } else if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    urls.push(`http://${hostname}:${port}`);
  }
  return [...new Set(urls)];
}
