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

function sanitizeLanguage(lang: string): string {
  return lang.replace(/[^a-zA-Z0-9\-\+#]/g, "").slice(0, 50);
}

function sanitizeTopic(topic: string): string {
  return topic.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "").slice(0, 50);
}

function sanitizeKeyword(kw: string): string {
  return kw.replace(/[^a-zA-Z0-9\s\-_\.]/g, "").slice(0, 100).trim();
}

function sanitizeOrgOrRepo(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_\.\/]/g, "").slice(0, 100);
}

function isValidGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com" && parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export { isValidGitHubUrl };

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async searchTopRepos(language: string, limit: number, topic?: string): Promise<RepoSummary[]> {
    const safeLang = language ? sanitizeLanguage(language) : "";
    const safeTopic = topic ? sanitizeTopic(topic) : "";
    const parts: string[] = [];
    if (safeLang) parts.push(`language:${safeLang}`);
    if (safeTopic) parts.push(`topic:${safeTopic}`);
    const starsThreshold = safeTopic && !safeLang ? "stars:>100" : "stars:>1000";
    parts.push(starsThreshold);
    const { data } = await this.octokit.search.repos({
      q: parts.join(" "),
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
    const [owner, repo] = sanitizeOrgOrRepo(fullName).split("/");
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
    const [owner, repo] = sanitizeOrgOrRepo(fullName).split("/");
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
    const safeOrg = sanitizeOrgOrRepo(org);
    try {
      const { data } = await this.octokit.repos.listForOrg({
        org: safeOrg,
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
      const safeKeyword = sanitizeKeyword(keyword);
      const safeLang = sanitizeLanguage(language);
      const safeLabel = label ? sanitizeKeyword(label) : undefined;
      const q = `${safeKeyword} in:title,body language:${safeLang} is:issue is:open${safeLabel ? ` label:${safeLabel}` : ""}`;
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q,
        sort: "reactions",
        order: "desc",
        per_page: Math.min(repoLimit * 10, 100),
      });
      return this.mapSearchItems(data.items);
    } catch {
      return [];
    }
  }

  async countIssues(language: string, topic?: string): Promise<number> {
    try {
      const parts = ["is:issue", "is:open"];
      if (language) parts.push(`language:${sanitizeLanguage(language)}`);
      if (topic) parts.push(sanitizeTopic(topic).replace(/-/g, " "));
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: parts.join(" "),
        per_page: 1,
      });
      return data.total_count;
    } catch {
      return 0;
    }
  }

  async fetchTrendingIssues(
    language: string,
    topic: string | undefined,
    timeframe: "daily" | "weekly" | "monthly",
    limit: number
  ): Promise<IssueData[]> {
    try {
      const days = timeframe === "daily" ? 1 : timeframe === "weekly" ? 7 : 30;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

      let q: string;
      if (topic && !language) {
        const repos = await this.searchTopRepos("", 10, topic);
        const repoQ = repos.slice(0, 8).map((r) => `repo:${r.fullName}`).join(" ");
        if (!repoQ) return [];
        q = `${repoQ} is:issue is:open updated:>=${since}`;
      } else {
        const parts = ["is:issue", "is:open", `updated:>=${since}`];
        if (language) parts.push(`language:${sanitizeLanguage(language)}`);
        if (topic) parts.push(sanitizeTopic(topic).replace(/-/g, " "));
        q = parts.join(" ");
      }

      const { data } = await this.octokit.search.issuesAndPullRequests({
        q,
        sort: "reactions",
        order: "desc",
        per_page: Math.min(limit, 50),
      });
      return this.mapSearchItems(data.items);
    } catch {
      return [];
    }
  }

  async fetchRepoMeta(fullName: string): Promise<{ description: string; languages: string[] }> {
    const [owner, repo] = sanitizeOrgOrRepo(fullName).split("/");
    if (!owner || !repo) return { description: "", languages: [] };
    try {
      const [repoData, langsData] = await Promise.all([
        this.octokit.repos.get({ owner, repo }),
        this.octokit.repos.listLanguages({ owner, repo }),
      ]);
      return {
        description: repoData.data.description ?? "",
        languages: Object.keys(langsData.data),
      };
    } catch {
      return { description: "", languages: [] };
    }
  }

  private mapSearchItems(items: any[]): IssueData[] {
    return items
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
  }
}
