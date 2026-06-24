import { describe, test, expect } from "bun:test";
import {
  tokenize,
  scoreCandidates,
  decideOverride,
  selectFewShot,
  recordExample,
  type LearnedExample,
  type LearningStore,
  type RepoCandidate,
} from "../lib/repoLearning";

const ex = (text: string, repo: string, host = "github.com"): LearnedExample => ({
  text,
  repo,
  host,
  ts: 0,
  corrected: false,
});

describe("tokenize", () => {
  test("lowercases, splits on non-alphanumeric, drops short + stopwords", () => {
    expect(tokenize("The Healthcheck PDF report crashes!")).toEqual([
      "healthcheck",
      "pdf",
      "report",
      "crashes",
    ]);
  });

  test("keeps tokens with digits", () => {
    expect(tokenize("vbr v12 backup")).toEqual(["vbr", "v12", "backup"]);
  });

  test("empty / punctuation-only yields no tokens", () => {
    expect(tokenize("!!! ?? .")).toEqual([]);
  });
});

describe("scoreCandidates", () => {
  const examples = [
    ex("vhc healthcheck pdf report crashes on open", "veeamhub/veeam-healthcheck"),
    ex("healthcheck report rendering broken", "veeamhub/veeam-healthcheck"),
    ex("calculator vault estimate is wrong total", "adamcongdon/calculators"),
  ];
  const candidates: RepoCandidate[] = [
    { name: "veeamhub/veeam-healthcheck", host: "github.com" },
    { name: "adamcongdon/calculators", host: "github.com" },
    { name: "adamcongdon/se-lz", host: "github.com" },
  ];

  test("ranks the repo whose examples match the feedback first", () => {
    const matches = scoreCandidates("the healthcheck pdf report is crashing again", examples, candidates);
    expect(matches[0].repo).toBe("veeamhub/veeam-healthcheck");
    expect(matches[0].confidence).toBeGreaterThan(0);
  });

  test("counts how many examples matched", () => {
    const matches = scoreCandidates("healthcheck report", examples, candidates);
    const top = matches.find((m) => m.repo === "veeamhub/veeam-healthcheck");
    expect(top?.matchCount).toBeGreaterThanOrEqual(1);
  });

  test("repos with no examples are omitted", () => {
    const matches = scoreCandidates("healthcheck report", examples, candidates);
    expect(matches.some((m) => m.repo === "adamcongdon/se-lz")).toBe(false);
  });

  test("no examples or no candidates yields no matches", () => {
    expect(scoreCandidates("anything", [], candidates)).toEqual([]);
    expect(scoreCandidates("anything", examples, [])).toEqual([]);
  });

  test("respects host as part of the key", () => {
    const matches = scoreCandidates("healthcheck report", examples, [
      { name: "veeamhub/veeam-healthcheck", host: "gitlab.com" },
    ]);
    expect(matches).toEqual([]);
  });
});

describe("decideOverride", () => {
  test("overrides when top confidence clears the threshold and the margin", () => {
    const decision = decideOverride([
      { repo: "a/b", host: "github.com", confidence: 0.6, matchCount: 3 },
      { repo: "c/d", host: "github.com", confidence: 0.2, matchCount: 1 },
    ]);
    expect(decision.suggestedRepo).toBe("a/b");
  });

  test("does not override below the confidence threshold", () => {
    const decision = decideOverride([
      { repo: "a/b", host: "github.com", confidence: 0.2, matchCount: 1 },
    ]);
    expect(decision.suggestedRepo).toBeNull();
  });

  test("does not override when two repos are too close (ambiguous)", () => {
    const decision = decideOverride([
      { repo: "a/b", host: "github.com", confidence: 0.5, matchCount: 2 },
      { repo: "c/d", host: "github.com", confidence: 0.46, matchCount: 2 },
    ]);
    expect(decision.suggestedRepo).toBeNull();
  });

  test("empty matches yields no override", () => {
    expect(decideOverride([]).suggestedRepo).toBeNull();
  });
});

describe("selectFewShot", () => {
  const examples = [
    ex("healthcheck pdf report crashes", "veeamhub/veeam-healthcheck"),
    ex("calculator vault estimate wrong", "adamcongdon/calculators"),
    ex("totally unrelated note about lunch plans tomorrow", "adamcongdon/se-lz"),
  ];

  test("returns the most similar examples, truncated to k", () => {
    const result = selectFewShot("healthcheck report crash", examples, 1);
    expect(result.length).toBe(1);
    expect(result[0].repo).toBe("veeamhub/veeam-healthcheck");
  });

  test("filters out examples with no meaningful overlap", () => {
    const result = selectFewShot("healthcheck report", examples, 5);
    expect(result.every((e) => e.repo !== "adamcongdon/se-lz")).toBe(true);
  });

  test("no overlap at all yields empty", () => {
    expect(selectFewShot("zzz qqq", examples).length).toBe(0);
  });
});

describe("recordExample", () => {
  const empty: LearningStore = { version: 1, examples: [] };

  test("prepends newest first", () => {
    let store = recordExample(empty, { text: "first", repo: "a/b", host: "github.com", ts: 1, corrected: false });
    store = recordExample(store, { text: "second", repo: "a/b", host: "github.com", ts: 2, corrected: false });
    expect(store.examples[0].text).toBe("second");
    expect(store.examples.length).toBe(2);
  });

  test("dedupes identical (text, repo, host)", () => {
    let store = recordExample(empty, { text: "same", repo: "a/b", host: "github.com", ts: 1, corrected: false });
    store = recordExample(store, { text: "same", repo: "a/b", host: "github.com", ts: 2, corrected: true });
    expect(store.examples.length).toBe(1);
    expect(store.examples[0].ts).toBe(2); // most recent moved to front
  });

  test("trims and truncates text; ignores blank", () => {
    const store = recordExample(empty, { text: "  hello  ", repo: "a/b", host: "github.com", ts: 1, corrected: false });
    expect(store.examples[0].text).toBe("hello");
    expect(recordExample(empty, { text: "   ", repo: "a/b", host: "github.com", ts: 1, corrected: false })).toBe(empty);
  });

  test("caps the store at 500 newest", () => {
    let store: LearningStore = empty;
    for (let i = 0; i < 520; i++) {
      store = recordExample(store, { text: `t${i}`, repo: "a/b", host: "github.com", ts: i, corrected: false });
    }
    expect(store.examples.length).toBe(500);
    expect(store.examples[0].text).toBe("t519");
  });
});
