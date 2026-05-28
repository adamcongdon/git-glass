import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";

export interface RepoInfo {
  name: string;
  host: string;
  owner: string;
  repo: string;
  remoteUrl: string;
  localPath: string;
}

interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".cache",
  "Library",
  "vendor",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
]);

export function shouldSkipDirectory(name: string): boolean {
  return SKIP_DIRS.has(name);
}

export function parseRemoteUrl(url: string): ParsedRemote | null {
  if (!url) return null;

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: sshMatch[1],
      owner: sshMatch[2],
      repo: sshMatch[3],
    };
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      host: httpsMatch[1],
      owner: httpsMatch[2],
      repo: httpsMatch[3],
    };
  }

  return null;
}

async function parseGitConfig(gitConfigPath: string): Promise<string | null> {
  try {
    const content = await readFile(gitConfigPath, "utf-8");
    // Find [remote "origin"] section and extract url
    const remoteSection = content.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/);
    if (remoteSection) {
      return remoteSection[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function walkDir(
  dirPath: string,
  currentDepth: number,
  maxDepth: number,
  results: RepoInfo[],
): Promise<void> {
  if (currentDepth > maxDepth || results.length >= 500) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  // Check if this directory is a git repo
  const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
  if (hasGit) {
    const gitConfigPath = join(dirPath, ".git", "config");
    const remoteUrl = await parseGitConfig(gitConfigPath);
    if (remoteUrl) {
      const parsed = parseRemoteUrl(remoteUrl);
      if (parsed && results.length < 500) {
        results.push({
          name: `${parsed.owner}/${parsed.repo}`,
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          remoteUrl,
          localPath: dirPath,
        });
      }
    }
    // Don't recurse into git repos (they may have submodules but we stop here)
    return;
  }

  // Recurse into subdirectories in parallel
  const subdirs = entries.filter(
    (e) => e.isDirectory() && !shouldSkipDirectory(e.name),
  );

  await Promise.all(
    subdirs.map(async (entry) => {
      if (results.length >= 500) return;
      await walkDir(join(dirPath, entry.name), currentDepth + 1, maxDepth, results);
    }),
  );
}

export async function scanRepos(
  scanPaths: string[],
  maxDepth: number = 3,
): Promise<RepoInfo[]> {
  const results: RepoInfo[] = [];

  for (const scanPath of scanPaths) {
    if (results.length >= 500) break;
    await walkDir(scanPath, 0, maxDepth, results);
  }

  return results;
}
