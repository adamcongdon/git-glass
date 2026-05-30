import { parseRemoteUrl } from "./scanner";
import type { Config } from "./config";

export interface AccountResolution {
  type: "github" | "gitlab" | "unknown";
  resolved: boolean;
  account?: string;
  availableAccounts: string[];
  host?: string;
  hasToken?: boolean;
}

export function resolveAccountForRemote(
  remoteUrl: string,
  config: Config,
  availableAccounts: string[],
): AccountResolution {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) {
    return { type: "unknown", resolved: false, availableAccounts };
  }

  if (parsed.host.toLowerCase() === "github.com") {
    const account =
      config.github.ownerAccounts[parsed.owner.toLowerCase()] ??
      config.github.defaultAccount;

    return {
      type: "github",
      resolved: !!account,
      account: account ?? undefined,
      availableAccounts,
    };
  }

  const hasToken = !!config.gitlab.tokens[parsed.host];
  return {
    type: "gitlab",
    resolved: hasToken,
    host: parsed.host,
    hasToken,
    availableAccounts: [],
  };
}
