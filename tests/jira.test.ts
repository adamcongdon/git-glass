import { describe, test, expect } from "bun:test";
import { JiraTargetSchema, buildJiraCreateUrl, fitJiraCreateUrl, JIRA_MAX_URL } from "../lib/jira";
import { ConfigSchema, redactConfig } from "../lib/config";

const target = JiraTargetSchema.parse({
  name: "Example",
  baseUrl: "https://example.atlassian.net/",
  projectId: "10001",
  issueTypeId: "10002",
  epicKey: "ABC-12",
  labels: ["cli-feedback", "triaged"],
});

describe("JiraTargetSchema", () => {
  test("defaults the epic field and labels", () => {
    const t = JiraTargetSchema.parse({
      name: "x",
      baseUrl: "https://x.atlassian.net",
      projectId: "1",
      issueTypeId: "2",
    });
    expect(t.epicField).toBe("customfield_10014");
    expect(t.labels).toEqual([]);
  });

  test("rejects http, non-numeric ids, bad epic keys, and labels with spaces", () => {
    const base = { name: "x", baseUrl: "https://x.atlassian.net", projectId: "1", issueTypeId: "2" };
    expect(JiraTargetSchema.safeParse({ ...base, baseUrl: "http://x.atlassian.net" }).success).toBe(false);
    expect(JiraTargetSchema.safeParse({ ...base, projectId: "ABC" }).success).toBe(false);
    expect(JiraTargetSchema.safeParse({ ...base, epicKey: "abc-1" }).success).toBe(false);
    expect(JiraTargetSchema.safeParse({ ...base, epicField: "summary" }).success).toBe(false);
    expect(JiraTargetSchema.safeParse({ ...base, labels: ["two words"] }).success).toBe(false);
  });
});

describe("buildJiraCreateUrl", () => {
  test("prefills every configured field on the Create form", () => {
    const url = new URL(buildJiraCreateUrl(target, "Title & more", "line 1\nline 2"));
    expect(url.origin + url.pathname).toBe("https://example.atlassian.net/secure/CreateIssueDetails!init.jspa");
    expect(url.searchParams.get("summary")).toBe("Title & more");
    expect(url.searchParams.get("description")).toBe("line 1\nline 2");
    expect(url.searchParams.get("pid")).toBe("10001");
    expect(url.searchParams.get("issuetype")).toBe("10002");
    expect(url.searchParams.get("customfield_10014")).toBe("ABC-12");
    expect(url.searchParams.getAll("labels")).toEqual(["cli-feedback", "triaged"]);
  });

  test("encodes spaces as %20 and omits the epic field when unset", () => {
    const { epicKey, ...noEpic } = target;
    const url = buildJiraCreateUrl(noEpic, "a b", "c");
    expect(url).toContain("summary=a%20b");
    expect(url).not.toContain("customfield_10014");
  });
});

describe("fitJiraCreateUrl", () => {
  test("leaves short descriptions alone", () => {
    const r = fitJiraCreateUrl(target, "t", "short");
    expect(r.truncated).toBe(false);
    expect(new URL(r.url).searchParams.get("description")).toBe("short");
  });

  test("cuts long descriptions to fit and says so", () => {
    const long = "word ".repeat(5000);
    const r = fitJiraCreateUrl(target, "t", long);
    expect(r.truncated).toBe(true);
    expect(r.url.length).toBeLessThanOrEqual(JIRA_MAX_URL);
    const desc = new URL(r.url).searchParams.get("description")!;
    expect(long.startsWith(desc.slice(0, desc.indexOf("\n\n…")))).toBe(true);
    expect(desc).toContain("truncated");
  });

  test("never splits an emoji surrogate pair", () => {
    const r = fitJiraCreateUrl(target, "t", "😀".repeat(3000), 2000);
    expect(r.truncated).toBe(true);
    expect(r.url.length).toBeLessThanOrEqual(2000);
  });

  test("throws when even the title cannot fit", () => {
    expect(() => fitJiraCreateUrl(target, "x".repeat(3000), "body", 1000)).toThrow();
  });
});

describe("config.jira", () => {
  test("defaults to no targets and passes targets through redaction", () => {
    expect(ConfigSchema.parse({}).jira.targets).toEqual([]);
    const cfg = ConfigSchema.parse({ jira: { targets: [target] } });
    expect(redactConfig(cfg).jira.targets[0].name).toBe("Example");
  });

  test("rejects duplicate target names", () => {
    expect(ConfigSchema.safeParse({ jira: { targets: [target, target] } }).success).toBe(false);
  });
});
