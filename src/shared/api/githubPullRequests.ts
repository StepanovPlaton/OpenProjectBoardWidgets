import type { OpenProjectClient } from "./client";
import { isRecord } from "./client";
import type { CiSummary, GithubCheckSummary, GithubPullRequestOverviewItem } from "../types";

function getEmbeddedCheckRuns(pr: Record<string, unknown>): Record<string, unknown>[] {
  const embedded = pr._embedded;
  if (!isRecord(embedded)) return [];
  const checkRuns = embedded.checkRuns;
  if (!Array.isArray(checkRuns)) return [];
  return checkRuns.filter((run): run is Record<string, unknown> => isRecord(run));
}

function isSuccessfulCheckRun(run: Record<string, unknown>): boolean {
  return run.conclusion === "success";
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getAuthor(pr: Record<string, unknown>): { name: string; url: string } {
  const embedded = pr._embedded;
  if (!isRecord(embedded) || !isRecord(embedded.githubUser)) {
    return { name: "", url: "" };
  }

  return {
    name: toString(embedded.githubUser.login),
    url: toString(embedded.githubUser.htmlUrl),
  };
}

function getRepositoryLabel(pr: Record<string, unknown>): string {
  const embedded = pr._embedded;
  if (isRecord(embedded) && isRecord(embedded.repository)) {
    const fullName = toString(embedded.repository.fullName);
    if (fullName) return fullName;
  }

  const githubLabel = toString(pr.githubIdentifier);
  const match = githubLabel.match(/^([^#]+)#\d+$/);
  return match?.[1] ?? "";
}

function getPullRequestNumber(pr: Record<string, unknown>): number | null {
  const value = pr.number;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mapCheckRun(run: Record<string, unknown>): GithubCheckSummary {
  return {
    name: toString(run.name) || "Check",
    state: toString(run.conclusion) || toString(run.status) || "unknown",
    detailsUrl: toString(run.detailsUrl),
  };
}

export async function fetchGithubPullRequests(
  client: OpenProjectClient,
  workPackageId: number,
): Promise<Record<string, unknown>[]> {
  return client.getCollection<Record<string, unknown>>(
    `/api/v3/work_packages/${workPackageId}/github_pull_requests`,
  );
}

export async function fetchGithubCiSummary(
  client: OpenProjectClient,
  workPackageId: number,
): Promise<CiSummary | null> {
  const pullRequests = await fetchGithubPullRequests(client, workPackageId);

  let successful = 0;
  let total = 0;

  for (const pr of pullRequests) {
    for (const run of getEmbeddedCheckRuns(pr)) {
      total += 1;
      if (isSuccessfulCheckRun(run)) successful += 1;
    }
  }

  if (total === 0) return null;

  return {
    successful,
    total,
    allSuccessful: successful === total,
    pullRequestCount: pullRequests.length,
  };
}

export async function fetchGithubPullRequestOverview(
  client: OpenProjectClient,
  workPackageId: number,
): Promise<GithubPullRequestOverviewItem[]> {
  const pullRequests = await fetchGithubPullRequests(client, workPackageId);

  return pullRequests.map((pr) => {
    const author = getAuthor(pr);
    const repositoryLabel = getRepositoryLabel(pr);
    const number = getPullRequestNumber(pr);
    const url = toString(pr.htmlUrl);

    return {
      id: typeof pr.id === "number" ? pr.id : Number(pr.id) || 0,
      number,
      repositoryLabel,
      url,
      title: toString(pr.title) || repositoryLabel || "Pull request",
      state: toString(pr.state) || "unknown",
      authorName: author.name,
      authorUrl: author.url,
      updatedAt: toString(pr.updatedAt) || null,
      checks: getEmbeddedCheckRuns(pr).map(mapCheckRun),
    };
  });
}
