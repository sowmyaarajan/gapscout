import type { IssueData, RepoSummary, Gap } from "./types.js";

const STOPWORDS = new Set([
  // English basics
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "this", "that", "these",
  "those", "i", "you", "he", "she", "it", "we", "they", "what", "which",
  "who", "when", "where", "why", "how", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "no", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "any", "as",
  "if", "use", "using", "need", "needs", "want", "wants", "make", "new",
  "get", "set", "way", "able", "like", "also", "now", "still", "yet",
  "out", "into", "about", "after", "before", "between", "through",
  "during", "above", "below", "under", "over", "again", "further", "then",
  "once", "here", "there", "while", "because", "until", "down",
  "off", "back", "around", "via", "per", "even", "ever", "much", "many",
  "your", "yours", "their", "theirs", "our", "ours", "his", "hers", "its",
  // Issue/PR template & meta noise
  "issue", "issues", "bug", "bugs", "feature", "features", "request",
  "requests", "please", "thanks", "thank", "hello", "okay",
  "checked", "existing", "searched", "search", "open",
  "closed", "duplicate", "related", "see", "look", "looking", "tried",
  "try", "trying", "found", "find", "fix", "fixes", "fixed", "fixing",
  "add", "added", "adding", "support", "supports", "supported", "works",
  "working", "work", "version", "versions", "current", "currently",
  "expected", "actual", "behavior", "behaviour", "describe", "description",
  "steps", "reproduce", "reproduction", "screenshot", "screenshots",
  "logs", "error", "errors", "message", "messages", "running",
  "runs", "install", "installed", "installation",
  "documentation", "docs", "readme", "guide", "example", "examples",
  "really", "actually", "probably", "maybe", "perhaps", "however", "though",
  "thing", "things", "stuff", "something", "anything", "nothing",
  "recent", "latest", "would", "should", "could", "make", "made",
  "feat", "implementation", "implement", "tracking", "track", "proposal",
  "rfc", "discussion", "todo", "task", "tasks", "milestone", "roadmap",
  // URL / markdown fragments
  "https", "http", "com", "org", "net",
  "www", "html", "blob", "tree", "master", "main", "branch",
  "commit", "pull", "merge", "link", "links", "url", "urls",
  "github", "gitlab",
  // Common code/tech that's too generic to be a "theme"
  "code", "file", "files", "line", "lines", "function", "method", "class",
  "value", "values", "data", "result", "results", "output", "input",
  "test", "tests", "testing", "case", "cases", "type", "types",
  "name", "names", "param", "params",
  "argument", "arguments", "option", "options",
  "default", "true", "false", "null", "none", "undefined", "object",
  "list", "array", "string", "number", "boolean",
]);

const URL_RE = /https?:\/\/\S+/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const HTML_TAG_RE = /<[^>]+>/g;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

function cleanText(text: string): string {
  return text
    .replace(CODE_BLOCK_RE, " ")
    .replace(INLINE_CODE_RE, " ")
    .replace(URL_RE, " ")
    .replace(HTML_TAG_RE, " ")
    .replace(EMOJI_RE, " ");
}

function tokenize(text: string): string[] {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= 4 &&
        w.length <= 20 &&
        !STOPWORDS.has(w) &&
        !/^\d+$/.test(w)
    );
}

function extractKeywords(issues: IssueData[], topN: number): string[] {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const titleTokens = new Set(tokenize(issue.title));
    const bodyTokens = new Set(tokenize(issue.body));
    // Title tokens weighted 3x — titles are signal, bodies are noise
    for (const t of titleTokens) {
      counts.set(t, (counts.get(t) ?? 0) + 3);
    }
    for (const t of bodyTokens) {
      if (!titleTokens.has(t)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 6) // Higher threshold = stronger signal
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

function clusterByKeyword(
  issues: IssueData[],
  keywords: string[]
): Map<string, IssueData[]> {
  const clusters = new Map<string, IssueData[]>();
  for (const kw of keywords) {
    // Match against title primarily; body is too noisy
    const matching = issues.filter((i) => {
      const titleHit = i.title.toLowerCase().includes(kw);
      // Allow body match only if it's a feature request (intent is clearer)
      const bodyHit = i.isFeatureRequest && i.body.toLowerCase().includes(kw);
      return titleHit || bodyHit;
    });
    if (matching.length >= 3) {
      clusters.set(kw, matching);
    }
  }
  return clusters;
}

function scoreGap(
  cluster: IssueData[],
  abandonedRepos: string[]
): number {
  const reactionWeight = cluster.reduce((s, i) => s + i.reactions, 0) * 2;
  const commentWeight = cluster.reduce((s, i) => s + i.comments, 0);
  const featureRequestBonus =
    cluster.filter((i) => i.isFeatureRequest).length * 5;
  const repoSpread = new Set(cluster.map((i) => i.repo)).size * 3;
  const abandonedBonus = abandonedRepos.length * 4;

  return (
    cluster.length * 2 +
    reactionWeight +
    commentWeight +
    featureRequestBonus +
    repoSpread +
    abandonedBonus
  );
}

export function findGaps(
  issues: IssueData[],
  repos: RepoSummary[],
  topGaps: number
): Gap[] {
  const featureRequests = issues.filter((i) => i.isFeatureRequest);
  const pool = featureRequests.length >= 20 ? featureRequests : issues;

  const keywords = extractKeywords(pool, 40);
  const clusters = clusterByKeyword(pool, keywords);

  const abandonedSet = new Set(
    repos.filter((r) => r.isAbandoned).map((r) => r.fullName)
  );

  const gaps: Gap[] = [];
  for (const [theme, cluster] of clusters) {
    const affectedRepos = [...new Set(cluster.map((i) => i.repo))];
    // Cross-repo filter: a real gap must show up in 2+ repos (ecosystem-wide signal)
    // unless it's a single repo with very high demand (lots of reactions)
    const totalReactions = cluster.reduce((s, i) => s + i.reactions, 0);
    if (affectedRepos.length < 2 && totalReactions < 100) continue;

    const abandonedAlts = affectedRepos.filter((r) => abandonedSet.has(r));
    const sorted = [...cluster].sort((a, b) => b.reactions - a.reactions);
    const relatedKeywords = extractKeywords(cluster, 8).filter(
      (k) => k !== theme
    );

    gaps.push({
      theme,
      keywords: relatedKeywords,
      issueCount: cluster.length,
      totalReactions: cluster.reduce((s, i) => s + i.reactions, 0),
      totalComments: cluster.reduce((s, i) => s + i.comments, 0),
      affectedRepos,
      abandonedAlternatives: abandonedAlts,
      sampleIssues: sorted.slice(0, 5).map((i) => ({
        repo: i.repo,
        title: i.title,
        url: i.url,
        reactions: i.reactions,
      })),
      gapScore: scoreGap(cluster, abandonedAlts),
    });
  }

  return gaps.sort((a, b) => b.gapScore - a.gapScore).slice(0, topGaps);
}
