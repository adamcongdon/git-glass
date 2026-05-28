export type IssueType = "bug" | "feature" | "question";

export interface IssueOptions {
  title: string;
  body: string;
  type: IssueType;
}

export interface IssueResult {
  url: string;
  number: number;
}

export interface GitHubError {
  code: string;
  message: string;
  status: number;
}

const TYPE_TO_LABEL: Record<IssueType, string> = {
  bug: "bug",
  feature: "enhancement",
  question: "question",
};

export function mapGitHubError(status: number, detail: string): GitHubError {
  switch (status) {
    case 401:
      return { code: "INVALID_TOKEN", message: "Invalid or expired token", status };
    case 403:
      return {
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Insufficient permissions to create issues",
        status,
      };
    case 404:
      return {
        code: "REPO_NOT_FOUND",
        message: "Repository not found or not accessible",
        status,
      };
    case 422:
      return {
        code: "VALIDATION_ERROR",
        message: `Validation error: ${detail}`,
        status,
      };
    default:
      if (status >= 500) {
        return {
          code: "SERVICE_UNAVAILABLE",
          message: "GitHub API is unavailable, please try again later",
          status,
        };
      }
      return {
        code: "GITHUB_ERROR",
        message: `GitHub API error: ${detail}`,
        status,
      };
  }
}

export function buildIssuePayload(
  options: IssueOptions,
): { title: string; body: string; labels: string[] } {
  const label = TYPE_TO_LABEL[options.type] ?? "question";
  return {
    title: options.title,
    body: options.body,
    labels: [label],
  };
}

async function uploadImageAsset(
  owner: string,
  repo: string,
  token: string,
  imageBase64: string,
  branch: string,
): Promise<string | null> {
  const raw = imageBase64.replace(/^data:[^;]+;base64,/, "");
  const filename = `feedback-${Date.now()}.png`;
  const path = `.github/issue-assets/${filename}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message: `chore: add feedback screenshot ${filename}`,
        content: raw,
        branch,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { content: { download_url: string } };
    return data.content?.download_url ?? null;
  } catch {
    return null;
  }
}

export async function uploadIssueImage(
  owner: string,
  repo: string,
  token: string,
  imageBase64: string,
): Promise<string | null> {
  // Try main, then master, then give up silently
  const url = await uploadImageAsset(owner, repo, token, imageBase64, "main");
  if (url) return url;
  return uploadImageAsset(owner, repo, token, imageBase64, "master");
}

export async function createIssue(
  owner: string,
  repo: string,
  token: string,
  options: IssueOptions,
  imageBase64?: string,
): Promise<IssueResult> {
  // Attempt image upload before creating issue (silent failure)
  let issueBody = options.body;
  if (imageBase64) {
    const imageUrl = await uploadIssueImage(owner, repo, token, imageBase64);
    if (imageUrl) {
      issueBody += `\n\n![screenshot](${imageUrl})`;
    }
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const payload = buildIssuePayload({ ...options, body: issueBody });

  const doRequest = async (includeLabels: boolean): Promise<Response> => {
    const body = includeLabels ? payload : { title: payload.title, body: payload.body };
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
  };

  let response = await doRequest(true);

  // If 422 (label doesn't exist), retry without labels
  if (response.status === 422) {
    console.error(
      `[github] Label '${payload.labels[0]}' may not exist, retrying without labels`,
    );
    response = await doRequest(false);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errorBody = await response.json();
      detail = errorBody.message ?? detail;
    } catch {}
    const err = mapGitHubError(response.status, detail);
    throw Object.assign(new Error(err.message), { code: err.code, status: err.status });
  }

  const data = (await response.json()) as { html_url: string; number: number };
  return {
    url: data.html_url,
    number: data.number,
  };
}
