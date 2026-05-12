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
          };
        });
    } catch {
      return [];
    }
  }
}
