let _accountsCache: string[] | null = null;

// Discover all github.com accounts logged in via `gh auth status`
export async function getGhAccounts(): Promise<string[]> {
  if (_accountsCache !== null) return _accountsCache;
  const proc = Bun.spawnSync(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // gh auth status writes to stderr
  const output =
    new TextDecoder().decode(proc.stderr) + new TextDecoder().decode(proc.stdout);
  const matches = [...output.matchAll(/Logged in to github\.com account (\S+)/g)];
  _accountsCache = [...new Set(matches.map((m) => m[1]))];
  return _accountsCache;
}

// Get OAuth token for a specific account, or the active account if none given
export async function getGhToken(account?: string): Promise<string> {
  const args: string[] = ["auth", "token"];
  if (account) args.push("-u", account);

  const proc = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const who = account ? ` for account "${account}"` : "";
    throw new Error(`gh auth token failed${who}: ${stderr || "unknown error"}`);
  }

  const token = new TextDecoder().decode(proc.stdout).trim();
  if (!token) throw new Error("gh returned an empty token");
  return token;
}
