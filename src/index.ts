#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GitHubClient } from "./github.js";
import { findGaps, analyzeRepo, filterIssues } from "./analyzer.js";
import { enrichGapsWithRegistry } from "./registry.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var is required");
  process.exit(1);
}

const github = new GitHubClient(token);

const server = new Server(
  { name: "gapscout", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "find_gaps",
      description:
        "Find underserved problem spaces on GitHub by analyzing open issues across popular repos in a given language. Returns ranked gaps with sample issues, demand signals (reactions, comments), age, velocity, and abandoned alternative repos.",
      inputSchema: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description: "Programming language (e.g., 'python', 'rust', 'go', 'typescript')",
          },
          repoLimit: {
            type: "number",
            description: "How many top repos to analyze (5-30). Default 15.",
            default: 15,
          },
          issuesPerRepo: {
            type: "number",
            description: "Max issues to pull per repo (10-50). Default 30.",
            default: 30,
          },
          topGaps: {
            type: "number",
            description: "How many gaps to return. Default 10.",
            default: 10,
          },
        },
        required: ["language"],
      },
    },
    {
      name: "search_issues",
      description:
        "Search for open GitHub issues across popular repos in a language with filters. Filter by keyword, issue age, staleness, labels, and contributor count. Returns issues sorted by opportunity score (demand × unresolved duration). Use maxParticipants to find untapped/ignored issues with few contributors.",
      inputSchema: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description: "Programming language to search within.",
          },
          repoLimit: {
            type: "number",
            description: "Repos to scan (5-30). Default 15.",
            default: 15,
          },
          issuesPerRepo: {
            type: "number",
            description: "Issues per repo when not using keyword search (10-50). Default 30.",
            default: 30,
          },
          keyword: {
            type: "string",
            description: "Filter: issues whose title contains this keyword.",
          },
          minAgeDays: {
            type: "number",
            description: "Filter: issues open at least this many days.",
          },
          maxAgeDays: {
            type: "number",
            description: "Filter: issues open at most this many days.",
          },
          isStale: {
            type: "boolean",
            description: "If true, return only stale issues (open 30+ days with no recent activity).",
          },
          label: {
            type: "string",
            description: "Filter: issues that have this label (e.g., 'good first issue', 'enhancement').",
          },
          maxParticipants: {
            type: "number",
            description: "Filter: issues with fewer than this many participants (proxy: comment count). Use to find untapped issues with few contributors.",
          },
          minReactions: {
            type: "number",
            description: "Filter: issues with at least this many reactions.",
          },
        },
        required: ["language"],
      },
    },
    {
      name: "analyze_repo",
      description:
        "Deep-dive a specific GitHub repo. Returns top open issues by demand, gap clusters within the repo, stale issues, label breakdown, and issue age distribution. Use this to understand a repo's pain points in detail.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Full repo name, e.g. 'microsoft/vscode' or 'rust-lang/rust'",
          },
          issuesPerPage: {
            type: "number",
            description: "Max issues to fetch (20-100). Default 50.",
            default: 50,
          },
        },
        required: ["repo"],
      },
    },
    {
      name: "analyze_org",
      description:
        "Analyze all public repos in a GitHub organization. Returns gap clusters across the org, a repo list with stats, and abandoned repos. Use this to find untapped opportunities within a specific organization like 'microsoft', 'vercel', or 'apache'.",
      inputSchema: {
        type: "object",
        properties: {
          org: { type: "string", description: "GitHub organization name, e.g. 'microsoft'" },
          repoLimit: { type: "number", description: "Max repos to analyze (5-50). Default 20.", default: 20 },
          language: { type: "string", description: "Optional: filter repos by language." },
          issuesPerRepo: { type: "number", description: "Issues per repo (10-50). Default 30.", default: 30 },
          topGaps: { type: "number", description: "Gap clusters to return. Default 10.", default: 10 },
        },
        required: ["org"],
      },
    },
    {
      name: "list_abandoned",
      description:
        "List popular repos in a language that appear abandoned (no commits in 12+ months). Useful for finding mature problem spaces where the existing solution has died.",
      inputSchema: {
        type: "object",
        properties: {
          language: { type: "string" },
          repoLimit: { type: "number", default: 30 },
        },
        required: ["language"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "find_gaps") {
    const language = String(args?.language ?? "");
    const repoLimit = Math.min(30, Math.max(5, Number(args?.repoLimit ?? 15)));
    const issuesPerRepo = Math.min(50, Math.max(10, Number(args?.issuesPerRepo ?? 30)));
    const topGaps = Math.min(25, Math.max(1, Number(args?.topGaps ?? 10)));

    const repos = await github.searchTopRepos(language, repoLimit);
    const allIssues = (
      await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
    ).flat();

    const rawGaps = findGaps(allIssues, repos, topGaps, language);
    const gaps = await enrichGapsWithRegistry(rawGaps, language);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              language,
              reposAnalyzed: repos.length,
              issuesAnalyzed: allIssues.length,
              featureRequestsFound: allIssues.filter((i) => i.isFeatureRequest).length,
              abandonedRepos: repos.filter((r) => r.isAbandoned).map((r) => r.fullName),
              gaps,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "search_issues") {
    const language = String(args?.language ?? "");
    const repoLimit = Math.min(30, Math.max(5, Number(args?.repoLimit ?? 15)));
    const issuesPerRepo = Math.min(50, Math.max(10, Number(args?.issuesPerRepo ?? 30)));
    const keyword = args?.keyword ? String(args.keyword) : undefined;
    const label = args?.label ? String(args.label) : undefined;

    let allIssues;
    let reposSearched: number;

    if (keyword) {
      allIssues = await github.searchIssuesByKeyword(language, keyword, repoLimit, label);
      reposSearched = new Set(allIssues.map((i) => i.repo)).size;
    } else {
      const repos = await github.searchTopRepos(language, repoLimit);
      reposSearched = repos.length;
      allIssues = (
        await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
      ).flat();
    }

    const filters = {
      keyword,
      minAgeDays: args?.minAgeDays ? Number(args.minAgeDays) : undefined,
      maxAgeDays: args?.maxAgeDays ? Number(args.maxAgeDays) : undefined,
      isStale: args?.isStale === true,
      label,
      maxParticipants: args?.maxParticipants ? Number(args.maxParticipants) : undefined,
      minReactions: args?.minReactions ? Number(args.minReactions) : undefined,
    };

    const filtered = filterIssues(allIssues, filters);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              language,
              reposSearched,
              totalFound: filtered.length,
              filters,
              issues: filtered.slice(0, 50),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "analyze_repo") {
    const repoName = String(args?.repo ?? "");
    const issuesPerPage = Math.min(100, Math.max(20, Number(args?.issuesPerPage ?? 50)));

    const repoInfo = await github.fetchRepoInfo(repoName);
    if (!repoInfo) {
      return {
        content: [{ type: "text", text: `Repo not found: ${repoName}` }],
        isError: true,
      };
    }

    const issues = await github.fetchOpenIssues(repoName, issuesPerPage);
    const analysis = analyzeRepo(issues, repoInfo);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(analysis, null, 2),
        },
      ],
    };
  }

  if (name === "analyze_org") {
    const org = String(args?.org ?? "");
    const repoLimit = Math.min(50, Math.max(5, Number(args?.repoLimit ?? 20)));
    const language = args?.language ? String(args.language) : undefined;
    const issuesPerRepo = Math.min(50, Math.max(10, Number(args?.issuesPerRepo ?? 30)));
    const topGaps = Math.min(25, Math.max(1, Number(args?.topGaps ?? 10)));

    const repos = await github.fetchOrgRepos(org, repoLimit, language);
    if (!repos.length) {
      return { content: [{ type: "text", text: `No repos found for org: ${org}` }], isError: true };
    }

    const allIssues = (
      await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
    ).flat();
    const gaps = findGaps(allIssues, repos, topGaps, language);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          org,
          reposFound: repos.length,
          issuesAnalyzed: allIssues.length,
          gaps,
          repos: repos.map((r) => ({
            fullName: r.fullName,
            stars: r.stars,
            lastPushed: r.lastPushed,
            openIssues: r.openIssues,
            isAbandoned: r.isAbandoned,
          })),
          abandonedRepos: repos.filter((r) => r.isAbandoned).map((r) => r.fullName),
        }, null, 2),
      }],
    };
  }

  if (name === "list_abandoned") {
    const language = String(args?.language ?? "");
    const repoLimit = Math.min(50, Math.max(5, Number(args?.repoLimit ?? 30)));
    const repos = await github.searchTopRepos(language, repoLimit);
    const abandoned = repos.filter((r) => r.isAbandoned);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              language,
              reposChecked: repos.length,
              abandonedCount: abandoned.length,
              abandoned: abandoned.map((r) => ({
                repo: r.fullName,
                stars: r.stars,
                lastPushed: r.lastPushed,
                openIssues: r.openIssues,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("GapScout MCP server running on stdio");
