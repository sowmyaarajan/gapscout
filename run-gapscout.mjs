#!/usr/bin/env node
import { readFileSync } from "fs";
import { GitHubClient } from "./dist/github.js";
import { findGaps } from "./dist/analyzer.js";

// Load .env manually
const env = readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const [k, ...rest] = line.split("=");
  if (k && rest.length) process.env[k.trim()] = rest.join("=").trim();
}

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("No GITHUB_TOKEN"); process.exit(1); }

const language = process.argv[2] ?? "rust";
const repoLimit = Number(process.argv[3] ?? 20);
const issuesPerRepo = Number(process.argv[4] ?? 40);
const topGaps = Number(process.argv[5] ?? 5);

console.error(`Scanning top ${repoLimit} ${language} repos, ${issuesPerRepo} issues each…`);

const github = new GitHubClient(token);
const repos = await github.searchTopRepos(language, repoLimit);
console.error(`Repos: ${repos.map(r => r.fullName).join(", ")}`);

const allIssues = (
  await Promise.all(repos.map(r => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
).flat();
console.error(`Total issues fetched: ${allIssues.length}`);

const gaps = findGaps(allIssues, repos, topGaps);

console.log(JSON.stringify({
  language,
  reposAnalyzed: repos.length,
  issuesAnalyzed: allIssues.length,
  featureRequestsFound: allIssues.filter(i => i.isFeatureRequest).length,
  gaps,
}, null, 2));
