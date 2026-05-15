import type { IssueData, RepoSummary, Gap, RepoAnalysis, RegistrySignal, WorthBuildingScore } from "./types.js";

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
  // Generic verbs/adjectives that produce noise themes
  "think", "view", "text", "consider", "show", "display", "render",
  "change", "update", "remove", "delete", "create", "build",
  "check", "read", "write", "load", "save", "send", "receive",
  "start", "stop", "open", "close", "enable", "disable",
  "allow", "block", "pass", "fail", "pass", "return",
  "move", "copy", "swap", "sort", "filter", "parse", "format",
  "convert", "generate", "process", "handle", "manage", "access",
  "apply", "attach", "bind", "call", "click", "drag", "drop",
  "emit", "fire", "focus", "hover", "init", "listen", "mount",
  "notify", "observe", "render", "reset", "resize", "scroll",
  "select", "submit", "toggle", "trigger", "unmount", "validate",
  "watch", "wrap",
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

function tokenize(text: string, excludeTerms?: Set<string>): string[] {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= 4 &&
        w.length <= 20 &&
        !STOPWORDS.has(w) &&
        !/^\d+$/.test(w) &&
        !(excludeTerms?.has(w))
    );
}

function extractBigrams(text: string, excludeTerms?: Set<string>): string[] {
  const tokens = tokenize(text, excludeTerms);
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

function extractKeywords(
  issues: IssueData[],
  topN: number,
  excludeTerms?: Set<string>
): string[] {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    const titleTokens = new Set(tokenize(issue.title, excludeTerms));
    const bodyTokens = new Set(tokenize(issue.body, excludeTerms));
    const titleBigrams = new Set(extractBigrams(issue.title, excludeTerms));

    // Title unigrams weighted 3x
    for (const t of titleTokens) {
      counts.set(t, (counts.get(t) ?? 0) + 3);
    }
    // Title bigrams weighted 4x (stronger signal)
    for (const b of titleBigrams) {
      counts.set(b, (counts.get(b) ?? 0) + 4);
    }
    // Body tokens (feature requests only) weighted 1x
    for (const t of bodyTokens) {
      if (!titleTokens.has(t) && issue.isFeatureRequest) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, c]) => c >= 6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

function clusterByKeyword(
  issues: IssueData[],
  keywords: string[],
  excludeTerms?: Set<string>
): Map<string, IssueData[]> {
  const clusters = new Map<string, IssueData[]>();
  for (const kw of keywords) {
    const isBigram = kw.includes(" ");
    const matching = issues.filter((i) => {
      if (excludeTerms) {
        const terms = kw.split(" ");
        if (terms.some((t) => excludeTerms.has(t))) return false;
      }
      const titleLower = i.title.toLowerCase();
      const bodyLower = i.body.toLowerCase();
      const titleHit = titleLower.includes(kw);
      const bodyHit = !isBigram && i.isFeatureRequest && bodyLower.includes(kw);
      return titleHit || bodyHit;
    });
    if (matching.length >= 4) {
      clusters.set(kw, matching);
    }
  }
  return clusters;
}

function scoreGap(cluster: IssueData[], abandonedRepos: string[]): number {
  const totalReactions = cluster.reduce((s, i) => s + i.reactions, 0);
  const reactionWeight = totalReactions * 2;
  const commentWeight = cluster.reduce((s, i) => s + i.comments, 0);
  const featureRequestBonus = cluster.filter((i) => i.isFeatureRequest).length * 5;
  const repoSpread = new Set(cluster.map((i) => i.repo)).size * 3;
  const abandonedBonus = abandonedRepos.length * 4;

  const oldest = cluster.reduce((max, i) => Math.max(max, i.ageDays), 0);
  const velocityScore = oldest > 0 ? (totalReactions / oldest) * 10 : 0;

  const staleCount = cluster.filter((i) => i.isStale).length;
  const stalenessBonus = staleCount * 3;

  const avgAge = cluster.reduce((s, i) => s + i.ageDays, 0) / cluster.length;
  const ancientBonus = avgAge > 180 ? 15 : avgAge > 90 ? 7 : 0;

  return (
    cluster.length * 2 +
    reactionWeight +
    commentWeight +
    featureRequestBonus +
    repoSpread +
    abandonedBonus +
    velocityScore +
    stalenessBonus +
    ancientBonus
  );
}

export function findGaps(
  issues: IssueData[],
  repos: RepoSummary[],
  topGaps: number,
  language?: string,
  singleRepoMode = false
): Gap[] {
  const excludeTerms = language
    ? new Set(language.toLowerCase().split(/\s+/))
    : undefined;

  const featureRequests = issues.filter((i) => i.isFeatureRequest);
  const pool = featureRequests.length >= 20 ? featureRequests : issues;

  const keywords = extractKeywords(pool, 40, excludeTerms);
  const clusters = clusterByKeyword(pool, keywords, excludeTerms);

  const abandonedSet = new Set(
    repos.filter((r) => r.isAbandoned).map((r) => r.fullName)
  );

  const gaps: Gap[] = [];
  for (const [theme, cluster] of clusters) {
    const affectedRepos = [...new Set(cluster.map((i) => i.repo))];
    const totalReactions = cluster.reduce((s, i) => s + i.reactions, 0);

    if (!singleRepoMode && affectedRepos.length < 2 && totalReactions < 100) continue;

    const abandonedAlts = affectedRepos.filter((r) => abandonedSet.has(r));
    const sorted = [...cluster].sort((a, b) => b.reactions - a.reactions);
    const relatedKeywords = extractKeywords(cluster, 8, excludeTerms).filter(
      (k) => k !== theme
    );

    const avgAgeDays = Math.floor(
      cluster.reduce((s, i) => s + i.ageDays, 0) / cluster.length
    );
    const avgParticipants = Math.floor(
      cluster.reduce((s, i) => s + i.participantCount, 0) / cluster.length
    );
    const oldest = cluster.reduce((max, i) => Math.max(max, i.ageDays), 0);
    const clusterReactions = cluster.reduce((s, i) => s + i.reactions, 0);
    const velocityScore =
      oldest > 0 ? Math.round((clusterReactions / oldest) * 100) / 100 : 0;

    gaps.push({
      theme,
      keywords: relatedKeywords,
      issueCount: cluster.length,
      totalReactions: clusterReactions,
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
      avgAgeDays,
      avgParticipants,
      velocityScore,
    });
  }

  return gaps.sort((a, b) => b.gapScore - a.gapScore).slice(0, topGaps);
}

export function filterIssues(
  issues: IssueData[],
  filters: {
    keyword?: string;
    minAgeDays?: number;
    maxAgeDays?: number;
    isStale?: boolean;
    label?: string;
    maxParticipants?: number;
    minReactions?: number;
  }
): IssueData[] {
  return issues
    .filter((i) => {
      if (filters.keyword && !i.title.toLowerCase().includes(filters.keyword.toLowerCase())) return false;
      if (filters.minAgeDays !== undefined && i.ageDays < filters.minAgeDays) return false;
      if (filters.maxAgeDays !== undefined && i.ageDays > filters.maxAgeDays) return false;
      if (filters.isStale && !i.isStale) return false;
      if (filters.label && !i.labels.some((l) => l.toLowerCase().includes(filters.label!.toLowerCase()))) return false;
      if (filters.maxParticipants !== undefined && i.participantCount > filters.maxParticipants) return false;
      if (filters.minReactions !== undefined && i.reactions < filters.minReactions) return false;
      return true;
    })
    .sort((a, b) => (b.reactions * 2 + b.ageDays * 0.1) - (a.reactions * 2 + a.ageDays * 0.1));
}

function buildReasoning(gap: Gap, registry: RegistrySignal | undefined, overall: number, demand: number, marketSize: number): string {
  const parts: string[] = [];
  if (demand >= 60) {
    parts.push(`strong GitHub demand (${gap.totalReactions} reactions across ${gap.affectedRepos.length} repos)`);
  } else if (demand >= 30) {
    parts.push(`moderate GitHub demand (${gap.totalReactions} reactions)`);
  }
  if (registry && registry.totalMonthlyDownloads > 0) {
    const dl = registry.totalMonthlyDownloads;
    const dlStr = dl >= 1_000_000 ? (dl / 1_000_000).toFixed(1) + "M" : dl >= 1_000 ? (dl / 1_000).toFixed(0) + "k" : String(dl);
    parts.push(`${dlStr} monthly downloads in ${registry.registry}`);
  }
  if (gap.avgAgeDays > 365) {
    parts.push(`unresolved for ${Math.round(gap.avgAgeDays / 30)} months`);
  }
  if (gap.abandonedAlternatives.length > 0) {
    parts.push(`${gap.abandonedAlternatives.length} abandoned alternative(s)`);
  }
  const verdict = overall >= 75 ? "strong opportunity" : overall >= 55 ? "promising gap" : overall >= 35 ? "niche area" : "saturated space";
  const base = parts.length > 0 ? parts.join(", ") + " — " : "";
  return `${base}${verdict}.`;
}

export function calcWorthBuilding(gap: Gap, registry?: RegistrySignal): WorthBuildingScore {
  const demand = Math.min(100, Math.round(gap.gapScore / 5));

  const dl = registry?.totalMonthlyDownloads ?? 0;
  const marketSize = dl > 0 ? Math.min(100, Math.round(Math.log10(dl) * 14.3)) : 15;

  const urgency = Math.min(100, Math.round(gap.avgAgeDays / 7.3));

  const competition = Math.min(100, 50 + gap.abandonedAlternatives.length * 10);

  const breadth = Math.min(100, gap.affectedRepos.length * 10);

  const overall = Math.round(
    demand * 0.35 + marketSize * 0.25 + urgency * 0.15 + competition * 0.15 + breadth * 0.10
  );

  const verdict: WorthBuildingScore["verdict"] =
    overall >= 75 ? "Strong opportunity" :
    overall >= 55 ? "Promising" :
    overall >= 35 ? "Niche" : "Saturated";

  const reasoning = buildReasoning(gap, registry, overall, demand, marketSize);

  return { overall, demand, marketSize, urgency, competition, breadth, verdict, reasoning };
}

export function analyzeRepo(issues: IssueData[], repoInfo: RepoSummary): RepoAnalysis {
  const topIssues = [...issues]
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, 10);

  const staleIssues = issues
    .filter((i) => i.isStale)
    .sort((a, b) => b.ageDays - a.ageDays);

  const gaps = findGaps(issues, [repoInfo], 5, undefined, true);

  const labelCounts = new Map<string, number>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  const labelBreakdown = [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([label, count]) => ({ label, count }));

  const buckets = [
    { bucket: "<30d", min: 0, max: 29 },
    { bucket: "30-90d", min: 30, max: 89 },
    { bucket: "90-180d", min: 90, max: 179 },
    { bucket: "180-365d", min: 180, max: 364 },
    { bucket: "1y+", min: 365, max: Infinity },
  ];
  const ageDistribution = buckets.map(({ bucket, min, max }) => ({
    bucket,
    count: issues.filter((i) => i.ageDays >= min && i.ageDays <= max).length,
  }));

  return {
    repo: repoInfo.fullName,
    stars: repoInfo.stars,
    openIssues: repoInfo.openIssues,
    topIssues,
    staleIssues,
    gaps,
    labelBreakdown,
    ageDistribution,
  };
}
