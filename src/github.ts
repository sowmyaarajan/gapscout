import { Octokit } from "@octokit/rest";
import type { IssueData, RepoSummary } from "./types.js";

const FEATURE_REQUEST_HINTS = [
  "feature request",
  "feature-request",
  "enhancement",
  "proposal",
  "rfc",
  "wishlist",
];

const FEATURE_TITLE_PATTERNS = [
  /^\[?(feature|request|proposal|rfc|idea)\]?[: ]/i,
  /\b(would be nice|please add|wish|missing|lacks|no way to|cannot|can't find)\b/i,
  /\bsupport for\b/i,
];

const ABANDONED_MONTHS = 12;

function isFeatureRequest(title: string, labels: string[]): boolean {
  const lowerLabels = labels.map((l) => l.toLowerCase());
  if (lowerLabels.some((l) => FEATURE_REQUEST_HINTS.some((h) => l.includes(h)))) {
    return true;
  }
  return FEATURE_TITLE_PATTERNS.some((p) => p.test(title));
}

function monthsSince(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24 * 30);
}

function calcAgeDays(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
}

function calcIsStale(createdAt: string, updatedAt: string): boolean {
  const age = calcAgeDays(createdAt);
  const lastActive = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000);
  return age > 30 && lastActive > 30;
}

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async searchTopRepos(language: string, limit: number): Promise<RepoSummary[]> {
    const { data } = await this.octokit.search.repos({
      q: `language:${language} stars:>1000`,
      sort: "stars",
      order: "desc",
      per_page: limit,
    });

    return data.items.map((r) => ({
      fullName: r.full_name,
      stars: r.stargazers_count ?? 0,
      lastPushed: r.pushed_at ?? "",
      openIssues: r.open_issues_count ?? 0,
      isAbandoned: r.pushed_at ? monthsSince(r.pushed_at) > ABANDONED_MONTHS : false,
    }));
  }

  async fetchRepoInfo(fullName: string): Promise<RepoSummary | null> {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) return null;
    try {
      const { data } = await this.octokit.repos.get({ owner, repo });
      return {
        fullName: data.full_name,
        stars: data.stargazers_count,
        lastPushed: data.pushed_at ?? "",
        openIssues: data.open_issues_count,
        isAbandoned: data.pushed_at ? monthsSince(data.pushed_at) > ABANDONED_MONTHS : false,
      };
    } catch {
      return null;
    }
  }

  async fetchOpenIssues(fullName: string, perRepo: number): Promise<IssueData[]> {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) return [];

    try {
      const { data } = await this.octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        per_page: perRepo,
        sort: "comments",
        direction: "desc",
      });

      return data
        .filter((i) => !i.pull_request)
        .map((i) => {
          const labels = (i.labels ?? [])
            .map((l) => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean);
          return {
            repo: fullName,
            number: i.number,
            title: i.title,
            body: (i.body ?? "").slice(0, 500),
            labels,
            reactions: i.reactions?.total_count ?? 0,
            comments: i.comments ?? 0,
            createdAt: i.created_at,
            url: i.html_url,
            isFeatureRequest: isFeatureRequest(i.title, labels),
            assignees: (i.assignees ?? []).length,
            lastActivityAt: i.updated_at,
            ageDays: calcAgeDays(i.created_at),
            isStale: calcIsStale(i.created_at, i.updated_at),
            participantCount: Math.min(i.comments ?? 0, 20),
          };
        });
    } catch {
      return [];
    }
  }

  async fetchOrgRepos(org: string, limit: number, language?: string): Promise<RepoSummary[]> {
    try {
      const { data } = await this.octokit.repos.listForOrg({
        org,
        sort: "pushed",
        direction: "desc",
        per_page: Math.min(100, limit * (language ? 5 : 1)),
        type: "public",
      });

      let repos = data;
      if (language) {
        repos = repos.filter((r) => r.language?.toLowerCase() === language.toLowerCase());
      }

      return repos.slice(0, limit).map((r) => ({
        fullName: r.full_name,
        stars: r.stargazers_count ?? 0,
        lastPushed: r.pushed_at ?? "",
        openIssues: r.open_issues_count ?? 0,
        isAbandoned: r.pushed_at ? monthsSince(r.pushed_at) > ABANDONED_MONTHS : false,
      }));
    } catch {
      return [];
    }
  }

  async searchIssuesByKeyword(
    language: string,
    keyword: string,
    repoLimit: number,
    label?: string
  ): Promise<IssueData[]> {
    try {
      const q = `${keyword} in:title,body language:${language} is:issue is:open${label ? ` label:${label}` : ""}`;
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q,
        sort: "reactions",
        order: "desc",
        per_page: Math.min(repoLimit * 10, 100),
      });

      return data.items
        .filter((i: any) => !i.pull_request)
        .map((i: any) => {
          const labels: string[] = (i.labels ?? [])
            .map((l: any) => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean);
          const repoFullName: string = (i.repository_url as string).replace(
            "https://api.github.com/repos/",
            ""
          );
          return {
            repo: repoFullName,
            number: i.number,
            title: i.title,
            body: (i.body ?? "").slice(0, 500),
            labels,
            reactions: i.reactions?.total_count ?? 0,
            comments: i.comments ?? 0,
            createdAt: i.created_at,
            url: i.html_url,
            isFeatureRequest: isFeatureRequest(i.title, labels),
            assignees: (i.assignees ?? []).length,
            lastActivityAt: i.updated_at,
            ageDays: calcAgeDays(i.created_at),
            isStale: calcIsStale(i.created_at, i.updated_at),
            participantCount: Math.min(i.comments ?? 0, 20),
          };
        });
    } catch {
      return [];
    }
  }
}
