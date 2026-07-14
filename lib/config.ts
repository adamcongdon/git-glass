import { z } from "zod";
import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { join, dirname, resolve as resolvePath } from "path";

export const AI_PROVIDERS = ["github-copilot", "anthropic", "openai", "grok", "openai-compatible", "local"] as const;
export type AiProvider = typeof AI_PROVIDERS[number];

export const ConfigSchema = z.object({
  scanPaths: z.array(z.string().min(1)).default([]),
  scanDepth: z.number().int().min(1).max(10).default(3),
  port: z.number().int().default(7777),
  ai: z
    .object({
      provider: z.enum(AI_PROVIDERS).default("github-copilot"),
      apiKey: z.string().optional(),   // stored at 0600; redacted from GET /api/config
      model: z.string().optional(),    // overrides the per-provider default
      baseUrl: z.string().optional(),  // required for openai-compatible; defaults for local
    })
    .default({}),
  github: z
    .object({
      copilotAccount: z.string().optional(),   // account with Copilot access (for AI triage)
      defaultAccount: z.string().optional(),   // fallback account for issue creation
      ownerAccounts: z.record(z.string()).default({}), // { "veeam": "v-AdamC" }
    })
    .default({}),
  gitlab: z
    .object({
      tokens: z.record(z.string()).default({}), // { "gitlab.veeam.com": "glpat-xxx" }
    })
    .default({}),
  ignoredRepos: z.array(z.string()).default([]),  // absolute paths hidden from repos view
  /** Inbox hard-hide: mute host/owner/repo from attention surfaces (not Repos ignore). */
  inbox: z
    .object({
      hiddenRepos: z
        .array(
          z.object({
            host: z.string().min(1).max(253),
            owner: z.string().min(1).max(256),
            repo: z.string().min(1).max(256),
          }),
        )
        .default([]),
    })
    .default({}),
  repos: z
    .object({
      autoRefreshSec: z.number().int().min(0).max(1800).default(0),
    })
    .default({}),
  updates: z
    .object({
      autoUpdate: z.boolean().default(false),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// GitHub usernames + AI provider/model/url are fine to expose.
// GitLab tokens and AI API keys are NOT — only presence is indicated.
export type RedactedConfig = {
  scanPaths: string[];
  scanDepth: number;
  port: number;
  ai: {
    provider: AiProvider;
    model?: string;
    baseUrl?: string;
    hasKey: boolean;
  };
  github: {
    copilotAccount?: string;
    defaultAccount?: string;
    ownerAccounts: Record<string, string>;
  };
  gitlab: {
    hosts: string[];
  };
  ignoredRepos: string[];
  inbox: {
    hiddenRepos: Array<{ host: string; owner: string; repo: string }>;
  };
  repos: {
    autoRefreshSec: number;
  };
  updates: {
    autoUpdate: boolean;
  };
};

const CONFIG_PATH = join(
  process.env.HOME ?? "/tmp",
  ".config",
  "feedback-tool",
  "config.json",
);

let _cache: Config | null = null;

export function redactConfig(config: Partial<Config>): RedactedConfig {
  return {
    scanPaths: config.scanPaths ?? [],
    scanDepth: config.scanDepth ?? 3,
    port: config.port ?? 7777,
    ai: {
      provider: config.ai?.provider ?? "github-copilot",
      model: config.ai?.model,
      baseUrl: config.ai?.baseUrl,
      hasKey: !!(config.ai?.apiKey),
    },
    github: {
      copilotAccount: config.github?.copilotAccount,
      defaultAccount: config.github?.defaultAccount,
      ownerAccounts: config.github?.ownerAccounts ?? {},
    },
    gitlab: {
      hosts: Object.keys(config.gitlab?.tokens ?? {}),
    },
    ignoredRepos: config.ignoredRepos ?? [],
    inbox: {
      hiddenRepos: config.inbox?.hiddenRepos ?? [],
    },
    repos: {
      autoRefreshSec: config.repos?.autoRefreshSec ?? 0,
    },
    updates: {
      autoUpdate: config.updates?.autoUpdate ?? false,
    },
  };
}

export async function readConfig(): Promise<Config> {
  if (_cache) return _cache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const result = ConfigSchema.safeParse(parsed);
    if (result.success) {
      _cache = result.data;
      return _cache;
    }
    console.error("Config validation failed, using defaults:", result.error.message);
    _cache = ConfigSchema.parse({});
    return _cache;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      const defaults = ConfigSchema.parse({});
      await writeConfigRaw(defaults);
      _cache = defaults;
      return _cache;
    }
    console.error("Failed to read config:", err.message);
    _cache = ConfigSchema.parse({});
    return _cache;
  }
}

// Merges `updates` into the persisted config. For `gitlab.tokens` specifically, an
// empty-string value DELETES the host entry; any non-empty value upserts. This avoids
// needing a separate DELETE endpoint and lets the UI flag rows for removal without
// re-sending other hosts' (redacted) tokens.
export async function writeConfig(updates: Partial<Config>): Promise<Config> {
  _cache = null;
  const existing = await readConfig();

  const incomingTokens = updates.gitlab?.tokens;
  let mergedTokens = existing.gitlab.tokens;
  if (incomingTokens) {
    mergedTokens = { ...existing.gitlab.tokens };
    for (const [host, token] of Object.entries(incomingTokens)) {
      if (token === "") {
        delete mergedTokens[host];
      } else {
        mergedTokens[host] = token;
      }
    }
  }

  // Canonicalize ignoredRepos paths on write (Architect refinement #5)
  const incomingIgnored = updates.ignoredRepos;
  const mergedIgnored = incomingIgnored !== undefined
    ? incomingIgnored.map((p) => resolvePath(p))
    : existing.ignoredRepos;

  const incomingAi = updates.ai;
  const mergedAi = incomingAi !== undefined
    ? {
        ...existing.ai,
        ...incomingAi,
        // Empty string deletes the stored key; omitted leaves the existing key intact.
        apiKey: incomingAi.apiKey === ""
          ? undefined
          : (incomingAi.apiKey ?? existing.ai.apiKey),
      }
    : existing.ai;

  const merged = {
    ...existing,
    ...updates,
    ai: mergedAi,
    github: {
      ...existing.github,
      ...(updates.github ?? {}),
    },
    gitlab: {
      tokens: mergedTokens,
    },
    ignoredRepos: mergedIgnored,
    inbox: updates.inbox !== undefined
      ? {
          ...existing.inbox,
          ...updates.inbox,
          hiddenRepos: updates.inbox.hiddenRepos ?? existing.inbox.hiddenRepos,
        }
      : existing.inbox,
    repos: updates.repos !== undefined
      ? { ...existing.repos, ...updates.repos }
      : existing.repos,
    updates: updates.updates !== undefined
      ? { ...existing.updates, ...updates.updates }
      : existing.updates,
  };
  const validated = ConfigSchema.parse(merged);
  await writeConfigRaw(validated);
  _cache = validated;
  return validated;
}

async function writeConfigRaw(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tmpPath = CONFIG_PATH + ".tmp";
  await writeFile(tmpPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  await rename(tmpPath, CONFIG_PATH);
}
