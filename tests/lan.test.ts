import { describe, test, expect } from "bun:test";
import { formatListenUrls, listLanIPv4 } from "../lib/lan";

describe("formatListenUrls", () => {
  test("loopback bind only lists 127.0.0.1", () => {
    expect(formatListenUrls("127.0.0.1", 7777)).toEqual(["http://127.0.0.1:7777"]);
  });

  test("0.0.0.0 includes loopback and any LAN IPs", () => {
    const urls = formatListenUrls("0.0.0.0", 7777);
    expect(urls).toContain("http://127.0.0.1:7777");
    for (const ip of listLanIPv4()) {
      expect(urls).toContain(`http://${ip}:7777`);
    }
  });
});
