// Convert a git remote URL to a browser-openable web URL.
// - SSH:   git@host:owner/repo(.git)        → https://host/owner/repo
// - ssh:// ssh://[user@]host[:port]/path     → https://host/path
// - HTTPS: https://host/owner/repo(.git)    → https://host/owner/repo
// GitLab subgroups (owner/sub/repo) are preserved.
//
// IMPORTANT: public/app.html duplicates this as `glassRemoteToWebUrl` because the
// SPA is served as static HTML with inline JS (no build step). Keep both in sync.
export function remoteToWebUrl(remote: string | null | undefined): string | null {
  if (!remote || typeof remote !== "string") return null;
  const trimmed = remote.trim().replace(/\.git$/i, "");
  let m = trimmed.match(/^git@([^:]+):(.+)$/);
  if (m) return "https://" + m[1] + "/" + m[2];
  m = trimmed.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (m) return "https://" + m[1] + "/" + m[2];
  if (/^https?:\/\/.+/.test(trimmed)) return trimmed;
  return null;
}
