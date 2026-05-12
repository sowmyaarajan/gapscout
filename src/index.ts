#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GitHubClient } from "./github.js";
import { findGaps } from "./analyzer.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var is required");
  process.exit(1);
}

const github = new GitHubClient(token);

const server = new Server(
  { name: "gapscout", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "find_gaps",
      description:
        "Find underserved problem spaces on GitHub by analyzing open issues across popular repos in a given language. Returns ranked gaps with sample issues, demand signals (reactions, comments), and abandoned alternative repos. Use this to surface product opportunities, validate ideas, or scout deal flow.",
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

    const gaps = findGaps(allIssues, repos, topGaps);

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
