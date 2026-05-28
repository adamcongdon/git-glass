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

export interface GitLabError {
  code: string;
  message: string;
  status: number;
}

const TYPE_TO_LABEL: Record<IssueType, string> = {
  bug: "bug",
  feature: "enhancement",
  question: "question",
};

export function mapGitLabError(status: number, detail: string): GitLabError {
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
          message: "GitLab API is unavailable, please try again later",
          status,
        };
      }
      return {
        code: "GITLAB_ERROR",
        message: `GitLab API error: ${detail}`,
        status,
      };
  }
}

export function buildIssuePayload(
  options: IssueOptions,
): { title: string; description: string; labels: string } {
  const label = TYPE_TO_LABEL[options.type] ?? "question";
  return {
    title: options.title,
    description: options.body,
    labels: label,
  };
}

function projectId(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

export async function uploadIssueImage(
  host: string,
  owner: string,
  repo: string,
  token: string,
  imageBase64: string,
  mimeType: string = "image/png",
): Promise<string | null> {
  const raw = imageBase64.replace(/^data:[^;]+;base64,/, "");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  const ext = mimeType.split("/")[1] ?? "png";
  form.append("file", blob, `feedback-${Date.now()}.${ext}`);

  try {
    const resp = await fetch(`${apiBase(host)}/projects/${projectId(owner, repo)}/uploads`, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": token },
      body: form,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { markdown?: string };
    return data.markdown ?? null;
  } catch {
    return null;
  }
}

export async function createIssue(
  host: string,
  owner: string,
  repo: string,
  token: string,
  options: IssueOptions,
  imageBase64?: string,
  imageMimeType?: string,
): Promise<IssueResult> {
  let description = options.body;
  if (imageBase64) {
    const markdown = await uploadIssueImage(host, owner, repo, token, imageBase64, imageMimeType);
    if (markdown) {
      description += `\n\n${markdown}`;
    }
  }

  const payload = buildIssuePayload({ ...options, body: description });
  const url = `${apiBase(host)}/projects/${projectId(owner, repo)}/issues`;

  const doRequest = async (includeLabels: boolean): Promise<Response> => {
    const body: Record<string, string> = {
      title: payload.title,
      description: payload.description,
    };
    if (includeLabels) body.labels = payload.labels;
    return fetch(url, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  };

  let response = await doRequest(true);
  if (response.status === 400 || response.status === 422) {
    console.error(`[gitlab] Label '${payload.labels}' rejected, retrying without labels`);
    response = await doRequest(false);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errorBody = (await response.json()) as { message?: string | string[]; error?: string };
      const msg = errorBody.message ?? errorBody.error;
      detail = Array.isArray(msg) ? msg.join("; ") : msg ?? detail;
    } catch {}
    const err = mapGitLabError(response.status, detail);
    throw Object.assign(new Error(err.message), { code: err.code, status: err.status });
  }

  const data = (await response.json()) as { web_url: string; iid: number };
  return {
    url: data.web_url,
    number: data.iid,
  };
}
