import "dotenv/config";
import { GitHubClient } from "./github.js";
import { findGaps } from "./analyzer.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN missing in .env");
  process.exit(1);
}

const language = process.argv[2] ?? "python";
console.log(`\nGapScout smoke test — language: ${language}\n`);

const github = new GitHubClient(token);

console.log("Fetching top 10 repos...");
const repos = await github.searchTopRepos(language, 10);
console.log(`Got ${repos.length} repos. Abandoned: ${repos.filter((r) => r.isAbandoned).length}`);

console.log("Fetching issues from each repo...");
const allIssues = (
  await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, 25)))
).flat();
console.log(
  `Got ${allIssues.length} issues. Feature requests: ${allIssues.filter((i) => i.isFeatureRequest).length}`
);

console.log("\nAnalyzing gaps...\n");
const gaps = findGaps(allIssues, repos, 5);

for (const [idx, g] of gaps.entries()) {
  console.log(`#${idx + 1} — Theme: "${g.theme}"  (score: ${g.gapScore})`);
  console.log(`   Issues: ${g.issueCount} | Reactions: ${g.totalReactions} | Repos: ${g.affectedRepos.length}`);
  console.log(`   Related: ${g.keywords.slice(0, 5).join(", ")}`);
  if (g.abandonedAlternatives.length) {
    console.log(`   Abandoned alternatives: ${g.abandonedAlternatives.join(", ")}`);
  }
  console.log(`   Top issue: ${g.sampleIssues[0]?.title?.slice(0, 80)}`);
  console.log("");
}

console.log("Smoke test OK\n");
