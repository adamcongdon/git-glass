// Repo-routing learning store.
//
// Captures (feedback text -> confirmed repo) pairs every time an issue is
// successfully created, then uses them to (a) inject few-shot precedent into the
// triage prompt and (b) deterministically override the AI's repo suggestion when
// the new feedback strongly resembles past corrections. Pure scoring functions
// (tokenize / scoreCandidates / selectFewShot / recordExample) are unit-tested
// directly; the IO wrappers mirror lib/config.ts (atomic 0600 write, module cache).

import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { join, dirname } from "path";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface LearnedExample {
  text: string;   // raw feedback (truncated to MAX_TEXT_LEN)
  repo: string;   // "owner/repo"
  host: string;   // git host, e.g. "github.com"
  ts: number;     // epoch ms
  corrected: boolean; // true if the user changed the AI's pick before submitting
}

export interface LearningStore {
  version: 1;
  examples: LearnedExample[]; // newest first
}

export interface RepoCandidate {
  name: string; // "owner/repo"
  host: string;
}

export interface RepoMatch {
  repo: string;
  host: string;
  confidence: number;  // 0..1
  matchCount: number;  // examples with confidence >= MATCH_THRESHOLD
}

export interface LearnedDecision {
  // The repo to override with, or null if no confident learned match.
  suggestedRepo: string | null;
  confidence: number;
  matches: RepoMatch[]; // top candidates by confidence, desc
}

// ─── Tunables ───────────────────────────────────────────────────────────────────

const MAX_EXAMPLES = 500;     // total store cap (newest kept)
const MAX_TEXT_LEN = 600;     // per-example stored text cap
const FEWSHOT_TEXT_LEN = 140; // per-example text length when injected into the prompt

const MATCH_THRESHOLD = 0.15;   // sim above which an example "matches"
const OVERRIDE_THRESHOLD = 0.35; // top confidence required to override the AI
const OVERRIDE_MARGIN = 0.1;     // top must beat the runner-up repo by this much

// Short, high-frequency words that carry no routing signal.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "has", "him", "his", "how", "man", "new",
  "now", "old", "see", "two", "way", "who", "boy", "did", "its", "let", "put",
  "say", "she", "too", "use", "with", "this", "that", "from", "have", "when",
  "what", "your", "they", "will", "would", "there", "their", "been", "were",
  "into", "then", "than", "them", "some", "such", "only", "also", "after",
  "issue", "bug", "page", "error", "doesnt", "does", "should", "could", "when",
  "click", "clicking", "shows", "showing", "still", "want", "need", "needs",
]);

// ─── Pure scoring ────────────────────────────────────────────────────────────────

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

// Inverse document frequency over the example corpus. Distinctive tokens
// (e.g. "healthcheck", "calculator") weigh far more than common ones.
function buildIdf(examples: LearnedExample[]): Map<string, number> {
  const n = examples.length;
  const df = new Map<string, number>();
  for (const ex of examples) {
    for (const t of tokenSet(ex.text)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, count] of df) {
    idf.set(t, Math.log((n + 1) / (count + 1)) + 1);
  }
  return idf;
}

// idf-weighted cosine similarity between two token sets, range 0..1.
function similarity(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  const w = (t: string) => idf.get(t) ?? 1;
  let dot = 0;
  for (const t of a) if (b.has(t)) dot += w(t) * w(t);
  let normA = 0;
  for (const t of a) normA += w(t) * w(t);
  let normB = 0;
  for (const t of b) normB += w(t) * w(t);
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

// Score each candidate repo by how strongly the new feedback resembles that
// repo's past examples. Returns matches sorted by confidence, descending.
export function scoreCandidates(
  text: string,
  examples: LearnedExample[],
  candidates: RepoCandidate[],
): RepoMatch[] {
  if (examples.length === 0 || candidates.length === 0) return [];
  const idf = buildIdf(examples);
  const inputTokens = tokenSet(text);
  if (inputTokens.size === 0) return [];

  const matches: RepoMatch[] = [];
  for (const cand of candidates) {
    const repoExamples = examples.filter(
      (e) => e.repo === cand.name && e.host === cand.host,
    );
    if (repoExamples.length === 0) continue;

    let best = 0;
    let matchCount = 0;
    for (const ex of repoExamples) {
      const sim = similarity(inputTokens, tokenSet(ex.text), idf);
      if (sim > best) best = sim;
      if (sim >= MATCH_THRESHOLD) matchCount++;
    }
    if (best > 0) {
      matches.push({ repo: cand.name, host: cand.host, confidence: best, matchCount });
    }
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}

// Decide whether the learned signal is strong enough to override the AI pick.
export function decideOverride(matches: RepoMatch[]): LearnedDecision {
  const top = matches[0];
  if (!top || top.confidence < OVERRIDE_THRESHOLD) {
    return { suggestedRepo: null, confidence: top?.confidence ?? 0, matches };
  }
  const second = matches[1];
  if (second && top.confidence - second.confidence < OVERRIDE_MARGIN) {
    // Two repos look equally plausible — don't gamble, let the AI decide.
    return { suggestedRepo: null, confidence: top.confidence, matches };
  }
  return { suggestedRepo: top.repo, confidence: top.confidence, matches };
}

// Top-k most similar past examples (across all repos) for prompt few-shot.
export function selectFewShot(
  text: string,
  examples: LearnedExample[],
  k = 5,
): LearnedExample[] {
  if (examples.length === 0) return [];
  const idf = buildIdf(examples);
  const inputTokens = tokenSet(text);
  if (inputTokens.size === 0) return [];
  return examples
    .map((ex) => ({ ex, sim: similarity(inputTokens, tokenSet(ex.text), idf) }))
    .filter((s) => s.sim >= MATCH_THRESHOLD)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map((s) => ({ ...s.ex, text: s.ex.text.slice(0, FEWSHOT_TEXT_LEN) }));
}

// Append a new example, newest-first, deduping identical (text, repo) pairs and
// capping the store. Pure — caller persists the returned store.
export function recordExample(
  store: LearningStore,
  example: Omit<LearnedExample, "text"> & { text: string },
): LearningStore {
  const text = example.text.trim().slice(0, MAX_TEXT_LEN);
  if (!text) return store;
  const entry: LearnedExample = { ...example, text };
  const deduped = store.examples.filter(
    (e) => !(e.text === text && e.repo === entry.repo && e.host === entry.host),
  );
  return { version: 1, examples: [entry, ...deduped].slice(0, MAX_EXAMPLES) };
}

// ─── Persistence ─────────────────────────────────────────────────────────────────

const STORE_PATH = join(
  process.env.HOME ?? "/tmp",
  ".config",
  "feedback-tool",
  "repo-learning.json",
);

const EMPTY_STORE: LearningStore = { version: 1, examples: [] };

let _cache: LearningStore | null = null;

export async function loadStore(): Promise<LearningStore> {
  if (_cache) return _cache;
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.examples)) {
      _cache = parsed as LearningStore;
      return _cache;
    }
    _cache = EMPTY_STORE;
    return _cache;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("Failed to read learning store:", err.message);
    _cache = EMPTY_STORE;
    return _cache;
  }
}

async function saveStore(store: LearningStore): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  const tmpPath = STORE_PATH + ".tmp";
  await writeFile(tmpPath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await rename(tmpPath, STORE_PATH);
  _cache = store;
}

// High-level: persist one confirmed routing. Best-effort — never throws.
export async function learn(example: {
  text: string;
  repo: string;
  host: string;
  corrected: boolean;
}): Promise<void> {
  try {
    const store = await loadStore();
    const next = recordExample(store, { ...example, ts: Date.now() });
    if (next !== store) await saveStore(next);
  } catch (err: any) {
    console.error("Failed to record learning example:", err?.message ?? err);
  }
}

// Read-only list of stored examples (newest first) for the Settings panel.
export async function listExamples(): Promise<LearnedExample[]> {
  const store = await loadStore();
  return store.examples;
}

// Remove one example identified by its dedup key (text + repo + host). Returns
// true if something was removed.
export async function deleteExample(key: { text: string; repo: string; host: string }): Promise<boolean> {
  const store = await loadStore();
  const next = store.examples.filter(
    (e) => !(e.text === key.text && e.repo === key.repo && e.host === key.host),
  );
  if (next.length === store.examples.length) return false;
  await saveStore({ version: 1, examples: next });
  return true;
}

// Wipe every learned example.
export async function clearStore(): Promise<void> {
  await saveStore({ version: 1, examples: [] });
}

// High-level: load store, return both the few-shot examples for the prompt and
// the deterministic override decision for the given feedback + candidate repos.
export async function evaluate(
  text: string,
  candidates: RepoCandidate[],
): Promise<{ fewShot: LearnedExample[]; decision: LearnedDecision }> {
  const store = await loadStore();
  const fewShot = selectFewShot(text, store.examples);
  const decision = decideOverride(scoreCandidates(text, store.examples, candidates));
  return { fewShot, decision };
}

// Test seam: reset the module cache so tests don't leak state.
export function _resetCache(): void {
  _cache = null;
}
