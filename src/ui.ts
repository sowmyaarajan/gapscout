import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { GitHubClient } from "./github.js";
import { findGaps, analyzeRepo, filterIssues } from "./analyzer.js";
import { enrichGapsWithRegistry } from "./registry.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var is required");
  process.exit(1);
}

const github = new GitHubClient(token);
const app = new Hono();

app.use("*", cors({
  origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type"],
}));

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  await next();
});

function safeError(e: any, context: string): Response {
  console.error(`[GapScout] ${context}:`, e?.message ?? e);
  return new Response(JSON.stringify({ error: "Request failed. Check server logs." }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

app.post("/api/find-gaps", async (c) => {
  try {
    const body = await c.req.json();
    const language = String(body.language ?? "");
    const topic = body.topic ? String(body.topic) : undefined;
    const repoLimit = Math.min(30, Math.max(5, Number(body.repoLimit ?? 15)));
    const issuesPerRepo = Math.min(50, Math.max(10, Number(body.issuesPerRepo ?? 30)));
    const topGaps = Math.min(25, Math.max(1, Number(body.topGaps ?? 10)));

    if (!language && !topic) return c.json({ error: "Provide at least a language or topic." }, 400);
    const repos = await github.searchTopRepos(language, repoLimit, topic);
    const allIssues = (
      await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
    ).flat();
    const rawGaps = findGaps(allIssues, repos, topGaps, language, false, topic);
    const gaps = await enrichGapsWithRegistry(rawGaps, language);

    return c.json({
      language,
      topic,
      reposAnalyzed: repos.length,
      issuesAnalyzed: allIssues.length,
      featureRequestsFound: allIssues.filter((i) => i.isFeatureRequest).length,
      abandonedRepos: repos.filter((r) => r.isAbandoned).map((r) => r.fullName),
      gaps,
    });
  } catch (e: any) {
    return safeError(e, "API error");
  }
});

app.post("/api/search-issues", async (c) => {
  try {
    const body = await c.req.json();
    const language = String(body.language ?? "");
    const topic = body.topic ? String(body.topic) : undefined;
    const repoLimit = Math.min(30, Math.max(5, Number(body.repoLimit ?? 15)));
    const issuesPerRepo = Math.min(50, Math.max(10, Number(body.issuesPerRepo ?? 30)));
    const keyword = body.keyword ? String(body.keyword) : undefined;
    const label = body.label ? String(body.label) : undefined;

    let allIssues;
    let reposSearched: number;

    if (keyword) {
      allIssues = await github.searchIssuesByKeyword(language, keyword, repoLimit, label);
      reposSearched = new Set(allIssues.map((i) => i.repo)).size;
    } else {
      const repos = await github.searchTopRepos(language, repoLimit, topic);
      reposSearched = repos.length;
      allIssues = (
        await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
      ).flat();
    }

    const filters = {
      keyword,
      minAgeDays: body.minAgeDays ? Number(body.minAgeDays) : undefined,
      maxAgeDays: body.maxAgeDays ? Number(body.maxAgeDays) : undefined,
      isStale: body.isStale === true,
      label,
      maxParticipants: body.maxParticipants ? Number(body.maxParticipants) : undefined,
      minReactions: body.minReactions ? Number(body.minReactions) : undefined,
    };

    const filtered = filterIssues(allIssues, filters);
    return c.json({ language, reposSearched, totalFound: filtered.length, filters, issues: filtered.slice(0, 50) });
  } catch (e: any) {
    return safeError(e, "API error");
  }
});

app.post("/api/analyze-repo", async (c) => {
  try {
    const body = await c.req.json();
    const repoName = String(body.repo ?? "");
    const issuesPerPage = Math.min(100, Math.max(20, Number(body.issuesPerPage ?? 50)));

    const repoInfo = await github.fetchRepoInfo(repoName);
    if (!repoInfo) return c.json({ error: `Repo not found: ${repoName}` }, 404);

    const issues = await github.fetchOpenIssues(repoName, issuesPerPage);
    const analysis = analyzeRepo(issues, repoInfo);
    return c.json(analysis);
  } catch (e: any) {
    return safeError(e, "API error");
  }
});

app.post("/api/analyze-org", async (c) => {
  try {
    const body = await c.req.json();
    const org = String(body.org ?? "");
    const repoLimit = Math.min(50, Math.max(5, Number(body.repoLimit ?? 20)));
    const language = body.language ? String(body.language) : undefined;
    const issuesPerRepo = Math.min(50, Math.max(10, Number(body.issuesPerRepo ?? 30)));
    const topGaps = Math.min(25, Math.max(1, Number(body.topGaps ?? 10)));

    const repos = await github.fetchOrgRepos(org, repoLimit, language);
    if (!repos.length) return c.json({ error: `No repos found for org: ${org}` }, 404);

    const allIssues = (
      await Promise.all(repos.map((r) => github.fetchOpenIssues(r.fullName, issuesPerRepo)))
    ).flat();
    const gaps = findGaps(allIssues, repos, topGaps, language);

    return c.json({
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
    });
  } catch (e: any) {
    return safeError(e, "API error");
  }
});

app.get("/api/abandoned/:language", async (c) => {
  try {
    const language = c.req.param("language") ?? "";
    const topic = c.req.query("topic") || undefined;
    const repoLimit = Math.min(50, Math.max(5, Number(c.req.query("repoLimit") ?? 30)));
    if (!language && !topic) return c.json({ error: "Provide a language or topic." }, 400);
    const repos = await github.searchTopRepos(language, repoLimit, topic);
    const abandoned = repos.filter((r) => r.isAbandoned);
    return c.json({
      language,
      reposChecked: repos.length,
      abandonedCount: abandoned.length,
      abandoned: abandoned.map((r) => ({
        repo: r.fullName,
        stars: r.stars,
        lastPushed: r.lastPushed,
        openIssues: r.openIssues,
      })),
    });
  } catch (e: any) {
    return safeError(e, "API error");
  }
});

app.get("/", (c) => c.html(DASHBOARD_HTML));

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GapScout</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:'Inter',sans-serif;min-height:100vh}
header{background:#1e293b;border-bottom:1px solid #334155;padding:16px 32px;display:flex;align-items:center;gap:12px}
header h1{font-size:20px;font-weight:700;color:#f8fafc}
header span{background:#3b82f6;color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px}
.container{max-width:1100px;margin:0 auto;padding:32px 24px}
.tabs{display:flex;gap:4px;margin-bottom:28px;border-bottom:1px solid #334155;padding-bottom:0}
.tab-btn{padding:10px 20px;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s}
.tab-btn.active{color:#3b82f6;border-bottom-color:#3b82f6}
.tab-btn:hover:not(.active){color:#e2e8f0}
.tab-panel{display:none}.tab-panel.active{display:block}
.form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:20px}
.form-group{display:flex;flex-direction:column;gap:6px}
label{font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
input,select{background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:14px;font-family:inherit;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:#3b82f6}
input[type=checkbox]{width:16px;height:16px;cursor:pointer;margin-top:4px}
.btn{background:#3b82f6;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.btn:hover{background:#2563eb}
.btn:disabled{background:#334155;cursor:not-allowed}
.btn-sm{padding:6px 12px;font-size:12px;background:#1e293b;border:1px solid #334155;color:#94a3b8}
.btn-sm:hover{background:#334155;color:#e2e8f0}
.spinner{display:none;text-align:center;padding:40px;color:#64748b}
.spinner.show{display:block}
.error-box{display:none;background:#450a0a;border:1px solid #991b1b;color:#fca5a5;padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:14px}
.error-box.show{display:block}
.results-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.results-header h3{font-size:16px;font-weight:600;color:#f1f5f9}
.badge{background:#1e293b;border:1px solid #334155;color:#94a3b8;font-size:11px;font-weight:600;padding:3px 8px;border-radius:10px}
.gap-card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;margin-bottom:12px}
.gap-card-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px}
.gap-theme{font-size:18px;font-weight:700;color:#f1f5f9;font-family:'JetBrains Mono',monospace}
.gap-score{background:#1d4ed8;color:#bfdbfe;font-size:12px;font-weight:700;padding:4px 10px;border-radius:6px}
.gap-meta{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.meta-item{font-size:13px;color:#64748b}
.meta-item strong{color:#94a3b8}
.keywords{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.kw-tag{background:#0f2040;color:#60a5fa;font-size:11px;font-family:'JetBrains Mono',monospace;padding:3px 8px;border-radius:4px}
.issues-list{display:flex;flex-direction:column;gap:6px}
.issue-link{display:flex;align-items:center;gap:8px;font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 8px;border-radius:4px;transition:background .1s}
.issue-link:hover{background:#334155;color:#e2e8f0}
.reactions-badge{background:#0f172a;color:#fbbf24;font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap}
.worth-building{margin:10px 0 8px;padding:10px 12px;background:#0f172a;border-radius:8px;border-left:3px solid #6366f1}
.wb-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;margin-bottom:6px}
.wb-badge.strong{background:#14532d;color:#86efac}
.wb-badge.promising{background:#1e3a5f;color:#93c5fd}
.wb-badge.niche{background:#3d2900;color:#fcd34d}
.wb-badge.saturated{background:#1e1e2e;color:#64748b}
.wb-score-num{font-size:13px;color:#94a3b8;margin-left:4px}
.wb-reasoning{font-size:12px;color:#64748b;margin-top:4px;line-height:1.5}
.wb-breakdown{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.wb-dim{display:flex;flex-direction:column;gap:2px;min-width:80px;flex:1}
.wb-dim-label{font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.05em}
.wb-dim-bar-wrap{background:#1e293b;border-radius:3px;height:4px;overflow:hidden}
.wb-dim-bar{height:4px;background:#6366f1;border-radius:3px;transition:width .3s}
.wb-dim-val{font-size:11px;color:#94a3b8;font-weight:600}
.registry-signal{margin-top:8px;font-size:12px;color:#475569;display:flex;align-items:center;gap:6px}
.registry-signal strong{color:#64748b}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;border-bottom:2px solid #334155;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
td{padding:10px 12px;border-bottom:1px solid #1e293b;vertical-align:top}
tr:hover td{background:#1e293b}
.stale-badge{background:#451a03;color:#fb923c;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px}
.label-tag{background:#1e293b;border:1px solid #334155;color:#94a3b8;font-size:11px;padding:2px 6px;border-radius:4px;display:inline-block;margin:1px}
a{color:#60a5fa;text-decoration:none}
a:hover{text-decoration:underline}
.section{margin-bottom:28px}
.section h4{font-size:14px;font-weight:600;color:#94a3b8;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e293b}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px}
.bar-label{width:120px;color:#94a3b8;text-align:right;flex-shrink:0}
.bar-track{flex:1;background:#1e293b;border-radius:3px;height:10px}
.bar-fill{background:#3b82f6;height:10px;border-radius:3px;min-width:2px}
.opp-card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;margin-bottom:10px;display:flex;flex-direction:column;gap:10px}
.opp-card-title{font-size:14px;font-weight:600;color:#f1f5f9;line-height:1.4}
.opp-card-meta{display:flex;gap:14px;font-size:12px;color:#64748b;flex-wrap:wrap;align-items:center}
.opp-card-actions{display:flex;gap:8px}
.btn-github{background:#238636;color:#fff;border:none;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.btn-github:hover{background:#2ea043;text-decoration:none}
.btn-pickup{background:#7c3aed;color:#fff;border:none;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer}
.btn-pickup:hover{background:#6d28d9}
.btn-pickup.picked{background:#334155;color:#64748b;cursor:default}
.picked-section{margin-top:24px;border-top:1px solid #334155;padding-top:20px}
.picked-section h4{font-size:14px;font-weight:600;color:#94a3b8;margin-bottom:12px}
.picked-item{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1e293b;border-radius:6px;margin-bottom:6px;font-size:13px}
.picked-item a{color:#60a5fa;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.picked-item .repo-name{color:#64748b;font-size:11px;font-family:monospace;white-space:nowrap}
.btn-remove{background:none;border:none;color:#64748b;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;flex-shrink:0}
.btn-remove:hover{color:#f87171;background:#450a0a}
.shuffle-bar{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.bar-count{color:#64748b;width:40px;flex-shrink:0}
.repo-info{display:flex;gap:20px;margin-bottom:20px;flex-wrap:wrap}
.repo-stat{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px;text-align:center}
.repo-stat-value{font-size:22px;font-weight:700;color:#f1f5f9;font-family:'JetBrains Mono',monospace}
.repo-stat-label{font-size:11px;color:#64748b;margin-top:2px}
</style>
</head>
<body>
<header>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
  <h1>GapScout</h1>
  <span>v0.2.0</span>
</header>
<div class="container">
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('find-gaps')">Find Gaps</button>
    <button class="tab-btn" onclick="switchTab('opportunities')">Opportunities</button>
    <button class="tab-btn" onclick="switchTab('search-issues')">Search Issues</button>
    <button class="tab-btn" onclick="switchTab('analyze-repo')">Analyze Repo</button>
    <button class="tab-btn" onclick="switchTab('organization')">Organization</button>
    <button class="tab-btn" onclick="switchTab('abandoned')">Abandoned Repos</button>
  </div>

  <!-- FIND GAPS -->
  <div id="tab-find-gaps" class="tab-panel active">
    <div class="form-grid">
      <div class="form-group"><label>Language</label><input id="fg-lang" placeholder="python, rust, typescript…"/></div>
      <div class="form-group"><label>Topic <span style="color:#475569;font-size:11px">(optional)</span></label><input id="fg-topic" placeholder="machine-learning, agents, llm…"/></div>
      <div class="form-group"><label>Repo Limit</label><input id="fg-repo-limit" type="number" value="15" min="5" max="30"/></div>
      <div class="form-group"><label>Issues Per Repo</label><input id="fg-issues-per-repo" type="number" value="30" min="10" max="50"/></div>
      <div class="form-group"><label>Top Gaps</label><input id="fg-top-gaps" type="number" value="10" min="1" max="25"/></div>
    </div>
    <button id="btn-fg" class="btn" onclick="runFindGaps()">Find Gaps</button>
    <div id="fg-spinner" class="spinner">Analyzing GitHub repos…</div>
    <div id="fg-error" class="error-box"></div>
    <div id="fg-results" style="margin-top:24px"></div>
  </div>

  <!-- OPPORTUNITIES -->
  <div id="tab-opportunities" class="tab-panel">
    <div class="form-grid">
      <div class="form-group"><label>Language</label><input id="op-lang" placeholder="python, rust, go…"/></div>
      <div class="form-group"><label>Topic <span style="color:#475569;font-size:11px">(optional)</span></label><input id="op-topic" placeholder="machine-learning, agents…"/></div>
      <div class="form-group"><label>Max Participants</label><input id="op-max-participants" type="number" value="3" min="1" max="20"/></div>
      <div class="form-group"><label>Min Reactions</label><input id="op-min-reactions" type="number" value="5" min="0"/></div>
      <div class="form-group"><label>Min Age (days)</label><input id="op-min-age" type="number" value="30" min="0"/></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
      <button id="btn-op" class="btn" onclick="runOpportunities()">Find Opportunities</button>
      <button class="btn btn-sm" onclick="shuffleOpportunities()" title="Shuffle results">⇄ Shuffle</button>
    </div>
    <p style="color:#64748b;font-size:12px;margin-bottom:20px">Issues with few contributors — good candidates to pick up and contribute to</p>
    <div id="op-spinner" class="spinner">Scanning for opportunities…</div>
    <div id="op-error" class="error-box"></div>
    <div id="op-cards"></div>
    <div id="op-picked"></div>
  </div>

  <!-- ORGANIZATION -->
  <div id="tab-organization" class="tab-panel">
    <div class="form-grid">
      <div class="form-group"><label>Organization *</label><input id="og-org" placeholder="microsoft, vercel, apache…"/></div>
      <div class="form-group"><label>Repo Limit</label><input id="og-repo-limit" type="number" value="20" min="5" max="50"/></div>
      <div class="form-group"><label>Language Filter</label><input id="og-lang" placeholder="optional"/></div>
      <div class="form-group"><label>Issues Per Repo</label><input id="og-issues-per-repo" type="number" value="30" min="10" max="50"/></div>
      <div class="form-group"><label>Top Gaps</label><input id="og-top-gaps" type="number" value="10" min="1" max="25"/></div>
    </div>
    <button id="btn-og" class="btn" onclick="runOrgAnalysis()">Analyze Organization</button>
    <div id="og-spinner" class="spinner">Fetching org repos and analyzing…</div>
    <div id="og-error" class="error-box"></div>
    <div id="og-results" style="margin-top:24px"></div>
  </div>

  <!-- SEARCH ISSUES -->
  <div id="tab-search-issues" class="tab-panel">
    <div class="form-grid">
      <div class="form-group"><label>Language</label><input id="si-lang" placeholder="python, rust…"/></div>
      <div class="form-group"><label>Topic <span style="color:#475569;font-size:11px">(optional)</span></label><input id="si-topic" placeholder="machine-learning, agents…"/></div>
      <div class="form-group"><label>Keyword</label><input id="si-keyword" placeholder="async, memory…"/></div>
      <div class="form-group"><label>Label</label><input id="si-label" placeholder="enhancement…"/></div>
      <div class="form-group"><label>Min Age (days)</label><input id="si-min-age" type="number" placeholder="90"/></div>
      <div class="form-group"><label>Max Age (days)</label><input id="si-max-age" type="number" placeholder=""/></div>
      <div class="form-group"><label>Max Participants</label><input id="si-max-participants" type="number" placeholder="5"/></div>
      <div class="form-group"><label>Min Reactions</label><input id="si-min-reactions" type="number" placeholder="10"/></div>
      <div class="form-group"><label>Stale Only</label><input id="si-stale" type="checkbox"/></div>
      <div class="form-group"><label>Repo Limit</label><input id="si-repo-limit" type="number" value="15"/></div>
    </div>
    <button id="btn-si" class="btn" onclick="runSearchIssues()">Search Issues</button>
    <div id="si-spinner" class="spinner">Searching issues…</div>
    <div id="si-error" class="error-box"></div>
    <div id="si-results" style="margin-top:24px"></div>
  </div>

  <!-- ANALYZE REPO -->
  <div id="tab-analyze-repo" class="tab-panel">
    <div class="form-grid">
      <div class="form-group"><label>Repo *</label><input id="ar-repo" placeholder="microsoft/vscode"/></div>
      <div class="form-group"><label>Issues to Fetch</label><input id="ar-issues" type="number" value="50" min="20" max="100"/></div>
    </div>
    <button id="btn-ar" class="btn" onclick="runAnalyzeRepo()">Analyze Repo</button>
    <div id="ar-spinner" class="spinner">Fetching repo data…</div>
    <div id="ar-error" class="error-box"></div>
    <div id="ar-results" style="margin-top:24px"></div>
  </div>

  <!-- ABANDONED REPOS -->
  <div id="tab-abandoned" class="tab-panel">
    <div class="form-grid">
      <div class="form-group"><label>Language</label><input id="ab-lang" placeholder="python, rust…"/></div>
      <div class="form-group"><label>Topic <span style="color:#475569;font-size:11px">(optional)</span></label><input id="ab-topic" placeholder="machine-learning, agents…"/></div>
      <div class="form-group"><label>Repo Limit</label><input id="ab-repo-limit" type="number" value="30"/></div>
    </div>
    <button id="btn-ab" class="btn" onclick="runAbandoned()">Find Abandoned</button>
    <div id="ab-spinner" class="spinner">Scanning repos…</div>
    <div id="ab-error" class="error-box"></div>
    <div id="ab-results" style="margin-top:24px"></div>
  </div>
</div>

<script>
let lastResult = null;

const TAB_IDS = ['find-gaps','opportunities','search-issues','analyze-repo','organization','abandoned'];

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    b.classList.toggle('active', TAB_IDS[i] === id);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  if (id === 'opportunities') renderPickedIssues();
}

function setLoading(prefix, show) {
  document.getElementById(prefix+'-spinner').classList.toggle('show', show);
  const btn = document.getElementById('btn-'+prefix);
  if (btn) btn.disabled = show;
}

function showError(prefix, msg) {
  const el = document.getElementById(prefix+'-error');
  el.textContent = msg;
  el.classList.add('show');
}

function clearError(prefix) {
  document.getElementById(prefix+'-error').classList.remove('show');
}

function exportJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function doExport() {
  if (!lastResult) return;
  const lang = lastResult.language || (lastResult.repo ? lastResult.repo.replace('/','_') : 'export');
  exportJSON(lastResult, 'gapscout-' + lang + '.json');
}

function resultsHeader(title, count) {
  return '<div class="results-header"><h3>' + title + ' <span class="badge">' + count + '</span></h3>'
    + '<button class="btn btn-sm" onclick="doExport()">Export JSON</button></div>';
}

async function runFindGaps() {
  clearError('fg');
  const lang = document.getElementById('fg-lang').value.trim();
  const topic = document.getElementById('fg-topic').value.trim();
  if (!lang && !topic) { showError('fg','Provide a language or topic (e.g. python, machine-learning)'); return; }
  setLoading('fg', true);
  document.getElementById('fg-results').innerHTML = '';
  try {
    const body = {
      language: lang,
      repoLimit: +document.getElementById('fg-repo-limit').value,
      issuesPerRepo: +document.getElementById('fg-issues-per-repo').value,
      topGaps: +document.getElementById('fg-top-gaps').value,
    };
    if (topic) body.topic = topic;
    const res = await fetch('/api/find-gaps', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) { showError('fg', data.error); return; }
    lastResult = data;
    renderGaps('fg-results', data);
  } catch(e) { showError('fg', e.message); }
  finally { setLoading('fg', false); }
}

function renderGaps(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.gaps || !data.gaps.length) { el.innerHTML = '<p style="color:#64748b">No gaps found.</p>'; return; }
  let html = resultsHeader('Gaps Found', data.gaps.length);
  html += '<p style="color:#64748b;font-size:13px;margin-bottom:16px">Analyzed ' + data.reposAnalyzed + ' repos · ' + data.issuesAnalyzed + ' issues · ' + data.featureRequestsFound + ' feature requests</p>';
  for (const gap of data.gaps) {
    html += '<div class="gap-card">';
    html += '<div class="gap-card-header"><span class="gap-theme">' + esc(gap.theme) + '</span><span class="gap-score">Score: ' + gap.gapScore + '</span></div>';
    html += '<div class="gap-meta">';
    html += '<span class="meta-item"><strong>' + gap.issueCount + '</strong> issues</span>';
    html += '<span class="meta-item"><strong>' + gap.totalReactions + '</strong> reactions</span>';
    html += '<span class="meta-item"><strong>' + gap.affectedRepos.length + '</strong> repos</span>';
    html += '<span class="meta-item">avg age <strong>' + gap.avgAgeDays + 'd</strong></span>';
    html += '<span class="meta-item">velocity <strong>' + gap.velocityScore + '</strong></span>';
    html += '</div>';
    if (gap.worthBuilding) {
      const wb = gap.worthBuilding;
      const cls = wb.verdict === 'Strong opportunity' ? 'strong' : wb.verdict === 'Promising' ? 'promising' : wb.verdict === 'Niche' ? 'niche' : 'saturated';
      html += '<div class="worth-building">';
      html += '<div><span class="wb-badge ' + cls + '">⚡ ' + esc(wb.verdict) + '</span><span class="wb-score-num">' + wb.overall + '/100</span></div>';
      html += '<div class="wb-reasoning">' + esc(wb.reasoning) + '</div>';
      html += '<div class="wb-breakdown">';
      [['Demand', wb.demand], ['Market', wb.marketSize], ['Urgency', wb.urgency], ['Competition', wb.competition], ['Breadth', wb.breadth]].forEach(function(d) {
        html += '<div class="wb-dim"><div class="wb-dim-label">' + d[0] + '</div><div class="wb-dim-bar-wrap"><div class="wb-dim-bar" style="width:' + d[1] + '%"></div></div><div class="wb-dim-val">' + d[1] + '</div></div>';
      });
      html += '</div>';
      if (gap.registrySignal && gap.registrySignal.registry !== 'none' && gap.registrySignal.totalMonthlyDownloads > 0) {
        const rs = gap.registrySignal;
        const dlFmt = rs.totalMonthlyDownloads >= 1000000 ? (rs.totalMonthlyDownloads/1000000).toFixed(1)+'M' : rs.totalMonthlyDownloads >= 1000 ? Math.round(rs.totalMonthlyDownloads/1000)+'k' : rs.totalMonthlyDownloads;
        const pkgNames = rs.topPackages.slice(0,3).map(function(p){return esc(p.name);}).join(', ');
        html += '<div class="registry-signal">📦 <strong>' + dlFmt + '</strong> downloads/mo via ' + esc(rs.registry) + (pkgNames ? ' (' + pkgNames + ')' : '') + '</div>';
      }
      html += '</div>';
    }
    if (gap.keywords.length) {
      html += '<div class="keywords">' + gap.keywords.map(k => '<span class="kw-tag">' + esc(k) + '</span>').join('') + '</div>';
    }
    html += '<div class="issues-list">' + gap.sampleIssues.map(i =>
      '<a class="issue-link" href="' + safeUrl(i.url) + '" target="_blank"><span class="reactions-badge">👍 ' + i.reactions + '</span>' + esc(i.title.slice(0,90)) + '</a>'
    ).join('') + '</div>';
    html += '</div>';
  }
  el.innerHTML = html;
}

async function runSearchIssues() {
  clearError('si');
  const lang = document.getElementById('si-lang').value.trim();
  const topic = document.getElementById('si-topic').value.trim();
  const kw = document.getElementById('si-keyword').value.trim();
  if (!lang && !topic && !kw) { showError('si','Provide a language, topic, or keyword'); return; }
  setLoading('si', true);
  document.getElementById('si-results').innerHTML = '';
  try {
    const body = { language: lang, repoLimit: +document.getElementById('si-repo-limit').value };
    if (topic) body.topic = topic;
    const label = document.getElementById('si-label').value.trim();
    const minAge = document.getElementById('si-min-age').value;
    const maxAge = document.getElementById('si-max-age').value;
    const maxP = document.getElementById('si-max-participants').value;
    const minR = document.getElementById('si-min-reactions').value;
    if (kw) body.keyword = kw;
    if (label) body.label = label;
    if (minAge) body.minAgeDays = +minAge;
    if (maxAge) body.maxAgeDays = +maxAge;
    if (maxP) body.maxParticipants = +maxP;
    if (minR) body.minReactions = +minR;
    body.isStale = document.getElementById('si-stale').checked;

    const res = await fetch('/api/search-issues', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) { showError('si', data.error); return; }
    lastResult = data;
    renderIssuesTable('si-results', data);
  } catch(e) { showError('si', e.message); }
  finally { setLoading('si', false); }
}

function renderIssuesTable(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.issues || !data.issues.length) { el.innerHTML = '<p style="color:#64748b">No issues found matching filters.</p>'; return; }
  let html = resultsHeader('Issues Found', data.totalFound);
  html += '<table><thead><tr><th>Repo</th><th>Title</th><th>Age</th><th>Reactions</th><th>Participants</th><th>Labels</th></tr></thead><tbody>';
  for (const i of data.issues) {
    html += '<tr>';
    html += '<td style="white-space:nowrap;font-family:monospace;font-size:12px">' + esc(i.repo) + '</td>';
    html += '<td><a href="' + safeUrl(i.url) + '" target="_blank">' + esc(i.title.slice(0,80)) + '</a>' + (i.isStale ? ' <span class="stale-badge">stale</span>' : '') + '</td>';
    html += '<td style="white-space:nowrap">' + i.ageDays + 'd</td>';
    html += '<td>' + i.reactions + '</td>';
    html += '<td>' + i.participantCount + '</td>';
    html += '<td>' + (i.labels || []).slice(0,3).map(l => '<span class="label-tag">' + esc(l) + '</span>').join('') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function runAnalyzeRepo() {
  clearError('ar');
  const repo = document.getElementById('ar-repo').value.trim();
  if (!repo) { showError('ar','Repo is required (e.g. microsoft/vscode)'); return; }
  setLoading('ar', true);
  document.getElementById('ar-results').innerHTML = '';
  try {
    const res = await fetch('/api/analyze-repo', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ repo, issuesPerPage: +document.getElementById('ar-issues').value })
    });
    const data = await res.json();
    if (data.error) { showError('ar', data.error); return; }
    lastResult = data;
    renderRepoAnalysis('ar-results', data);
  } catch(e) { showError('ar', e.message); }
  finally { setLoading('ar', false); }
}

function renderRepoAnalysis(containerId, d) {
  const el = document.getElementById(containerId);
  let html = '<div class="results-header"><h3>' + esc(d.repo) + '</h3><button class="btn btn-sm" onclick="doExport()">Export JSON</button></div>';
  html += '<div class="repo-info">';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (d.stars||0).toLocaleString() + '</div><div class="repo-stat-label">Stars</div></div>';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (d.openIssues||0).toLocaleString() + '</div><div class="repo-stat-label">Open Issues</div></div>';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (d.staleIssues||[]).length + '</div><div class="repo-stat-label">Stale Issues</div></div>';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (d.gaps||[]).length + '</div><div class="repo-stat-label">Gap Clusters</div></div>';
  html += '</div>';

  // Top Issues
  html += '<div class="section"><h4>Top Issues by Demand</h4>';
  html += '<div class="issues-list">' + (d.topIssues||[]).map(i =>
    '<a class="issue-link" href="' + safeUrl(i.url) + '" target="_blank"><span class="reactions-badge">👍 ' + i.reactions + '</span>' + esc(i.title.slice(0,90)) + (i.isStale ? ' <span class="stale-badge">stale</span>' : '') + '</a>'
  ).join('') + '</div></div>';

  // Gaps
  if (d.gaps && d.gaps.length) {
    html += '<div class="section"><h4>Gap Clusters</h4>';
    for (const gap of d.gaps) {
      html += '<div class="gap-card">';
      html += '<div class="gap-card-header"><span class="gap-theme">' + esc(gap.theme) + '</span><span class="gap-score">Score: ' + gap.gapScore + '</span></div>';
      html += '<div class="gap-meta"><span class="meta-item"><strong>' + gap.issueCount + '</strong> issues</span><span class="meta-item"><strong>' + gap.totalReactions + '</strong> reactions</span><span class="meta-item">avg age <strong>' + gap.avgAgeDays + 'd</strong></span></div>';
      if (gap.keywords.length) html += '<div class="keywords">' + gap.keywords.map(k => '<span class="kw-tag">' + esc(k) + '</span>').join('') + '</div>';
      html += '<div class="issues-list">' + (gap.sampleIssues||[]).map(i => '<a class="issue-link" href="' + safeUrl(i.url) + '" target="_blank"><span class="reactions-badge">👍 ' + i.reactions + '</span>' + esc(i.title.slice(0,80)) + '</a>').join('') + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Age Distribution
  if (d.ageDistribution) {
    const maxCount = Math.max(...d.ageDistribution.map(b => b.count), 1);
    html += '<div class="section"><h4>Issue Age Distribution</h4>';
    for (const b of d.ageDistribution) {
      html += '<div class="bar-row"><span class="bar-label">' + b.bucket + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(b.count/maxCount*100) + '%"></div></div><span class="bar-count">' + b.count + '</span></div>';
    }
    html += '</div>';
  }

  // Label Breakdown
  if (d.labelBreakdown && d.labelBreakdown.length) {
    const maxCount = Math.max(...d.labelBreakdown.map(l => l.count), 1);
    html += '<div class="section"><h4>Label Breakdown</h4>';
    for (const l of d.labelBreakdown) {
      html += '<div class="bar-row"><span class="bar-label" style="font-size:11px">' + esc(l.label.slice(0,16)) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(l.count/maxCount*100) + '%"></div></div><span class="bar-count">' + l.count + '</span></div>';
    }
    html += '</div>';
  }

  // Stale Issues
  if (d.staleIssues && d.staleIssues.length) {
    html += '<div class="section"><h4>Stale Issues (' + d.staleIssues.length + ')</h4><table><thead><tr><th>Title</th><th>Age</th><th>Reactions</th></tr></thead><tbody>';
    for (const i of d.staleIssues.slice(0,20)) {
      html += '<tr><td><a href="' + safeUrl(i.url) + '" target="_blank">' + esc(i.title.slice(0,80)) + '</a></td><td>' + i.ageDays + 'd</td><td>' + i.reactions + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }

  el.innerHTML = html;
}

async function runAbandoned() {
  clearError('ab');
  const lang = document.getElementById('ab-lang').value.trim();
  const topic = document.getElementById('ab-topic').value.trim();
  if (!lang && !topic) { showError('ab','Provide a language or topic'); return; }
  setLoading('ab', true);
  document.getElementById('ab-results').innerHTML = '';
  try {
    const repoLimit = document.getElementById('ab-repo-limit').value;
    const topicParam = topic ? '&topic=' + encodeURIComponent(topic) : '';
    const res = await fetch('/api/abandoned/' + encodeURIComponent(lang) + '?repoLimit=' + repoLimit + topicParam);
    const data = await res.json();
    if (data.error) { showError('ab', data.error); return; }
    lastResult = data;
    renderAbandoned('ab-results', data);
  } catch(e) { showError('ab', e.message); }
  finally { setLoading('ab', false); }
}

function renderAbandoned(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.abandoned || !data.abandoned.length) { el.innerHTML = '<p style="color:#64748b">No abandoned repos found in top ' + data.reposChecked + '.</p>'; return; }
  let html = resultsHeader('Abandoned Repos', data.abandonedCount);
  html += '<table><thead><tr><th>Repo</th><th>Stars</th><th>Last Pushed</th><th>Open Issues</th></tr></thead><tbody>';
  for (const r of data.abandoned) {
    const d = new Date(r.lastPushed).toLocaleDateString();
    html += '<tr><td><a href="https://github.com/' + r.repo + '" target="_blank">' + esc(r.repo) + '</a></td><td>' + (r.stars||0).toLocaleString() + '</td><td>' + d + '</td><td>' + r.openIssues + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function safeUrl(url) {
  try {
    const p = new URL(url);
    return (p.hostname === 'github.com' && p.protocol === 'https:') ? esc(url) : '#';
  } catch { return '#'; }
}

// ── OPPORTUNITIES ──────────────────────────────────────────────
let opportunities = [];

async function runOpportunities() {
  clearError('op');
  const lang = document.getElementById('op-lang').value.trim();
  const topic = document.getElementById('op-topic').value.trim();
  if (!lang && !topic) { showError('op','Provide a language or topic'); return; }
  setLoading('op', true);
  document.getElementById('op-cards').innerHTML = '';
  try {
    const opBody = {
      language: lang,
      maxParticipants: +document.getElementById('op-max-participants').value || 3,
      minReactions:    +document.getElementById('op-min-reactions').value || 5,
      minAgeDays:      +document.getElementById('op-min-age').value || 30,
      repoLimit: 15, issuesPerRepo: 50,
    };
    if (topic) opBody.topic = topic;
    const res = await fetch('/api/search-issues', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(opBody)
    });
    const data = await res.json();
    if (data.error) { showError('op', data.error); return; }
    lastResult = data;
    opportunities = data.issues || [];
    renderOpportunityCards();
    renderPickedIssues();
  } catch(e) { showError('op', e.message); }
  finally { setLoading('op', false); }
}

function shuffleOpportunities() {
  if (!opportunities.length) return;
  for (let i = opportunities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opportunities[i], opportunities[j]] = [opportunities[j], opportunities[i]];
  }
  renderOpportunityCards();
}

function renderOpportunityCards() {
  const el = document.getElementById('op-cards');
  if (!opportunities.length) { el.innerHTML = '<p style="color:#64748b">No opportunities found. Try lowering Min Reactions or Min Age.</p>'; return; }
  const picked = JSON.parse(localStorage.getItem('gapscout-picked') || '[]');
  const pickedUrls = new Set(picked.map(function(p) { return p.url; }));
  let html = '<p style="color:#64748b;font-size:13px;margin-bottom:16px">' + opportunities.length + ' opportunities found</p>';
  opportunities.slice(0, 25).forEach(function(issue, idx) {
    const isPickedUp = pickedUrls.has(issue.url);
    html += '<div class="opp-card">';
    html += '<div class="opp-card-title">' + esc(issue.title) + '</div>';
    html += '<div style="font-size:11px;color:#3b82f6;font-family:monospace">' + esc(issue.repo) + '</div>';
    html += '<div class="opp-card-meta">';
    html += '<span>👍 ' + issue.reactions + '</span>';
    html += '<span>🕐 ' + issue.ageDays + 'd old</span>';
    html += '<span>👥 ' + issue.participantCount + ' participants</span>';
    if (issue.isStale) html += '<span class="stale-badge">stale</span>';
    html += '</div>';
    html += '<div class="opp-card-actions">';
    html += '<a class="btn-github" href="' + safeUrl(issue.url) + '" target="_blank">Open on GitHub</a>';
    if (isPickedUp) {
      html += '<button class="btn-pickup picked" disabled>Picked Up</button>';
    } else {
      html += '<button class="btn-pickup" onclick="pickUpByIndex(' + idx + ')">Pick Up</button>';
    }
    html += '</div></div>';
  });
  el.innerHTML = html;
}

function pickUpByIndex(idx) {
  const issue = opportunities[idx];
  if (!issue) return;
  const picked = JSON.parse(localStorage.getItem('gapscout-picked') || '[]');
  if (!picked.find(function(p) { return p.url === issue.url; })) {
    picked.push({ title: issue.title, repo: issue.repo, url: issue.url, reactions: issue.reactions, ageDays: issue.ageDays });
    localStorage.setItem('gapscout-picked', JSON.stringify(picked));
  }
  renderOpportunityCards();
  renderPickedIssues();
}

function removePickedIssue(idx) {
  const picked = JSON.parse(localStorage.getItem('gapscout-picked') || '[]');
  picked.splice(idx, 1);
  localStorage.setItem('gapscout-picked', JSON.stringify(picked));
  renderPickedIssues();
  renderOpportunityCards();
}

function renderPickedIssues() {
  const el = document.getElementById('op-picked');
  if (!el) return;
  const picked = JSON.parse(localStorage.getItem('gapscout-picked') || '[]');
  if (!picked.length) { el.innerHTML = ''; return; }
  let html = '<div class="picked-section"><h4>My Picked Issues (' + picked.length + ')</h4>';
  picked.forEach(function(issue, idx) {
    html += '<div class="picked-item">';
    html += '<a href="' + safeUrl(issue.url) + '" target="_blank">' + esc(issue.title.slice(0,70)) + '</a>';
    html += '<span class="repo-name">' + esc(issue.repo) + '</span>';
    html += '<span style="color:#64748b;font-size:11px">' + issue.ageDays + 'd</span>';
    html += '<button class="btn-remove" onclick="removePickedIssue(' + idx + ')">✕</button>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ── ORGANIZATION ───────────────────────────────────────────────
async function runOrgAnalysis() {
  clearError('og');
  const org = document.getElementById('og-org').value.trim();
  if (!org) { showError('og','Organization name is required'); return; }
  setLoading('og', true);
  document.getElementById('og-results').innerHTML = '';
  try {
    const langVal = document.getElementById('og-lang').value.trim();
    const res = await fetch('/api/analyze-org', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        org,
        repoLimit:      +document.getElementById('og-repo-limit').value || 20,
        language:       langVal || undefined,
        issuesPerRepo:  +document.getElementById('og-issues-per-repo').value || 30,
        topGaps:        +document.getElementById('og-top-gaps').value || 10,
      })
    });
    const data = await res.json();
    if (data.error) { showError('og', data.error); return; }
    lastResult = data;
    renderOrgAnalysis('og-results', data);
  } catch(e) { showError('og', e.message); }
  finally { setLoading('og', false); }
}

function renderOrgAnalysis(containerId, data) {
  const el = document.getElementById(containerId);
  let html = resultsHeader(esc(data.org) + ' Organization', data.reposFound + ' repos');
  html += '<div class="repo-info">';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (data.reposFound||0) + '</div><div class="repo-stat-label">Repos</div></div>';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (data.issuesAnalyzed||0).toLocaleString() + '</div><div class="repo-stat-label">Issues</div></div>';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (data.gaps||[]).length + '</div><div class="repo-stat-label">Gaps</div></div>';
  html += '<div class="repo-stat"><div class="repo-stat-value">' + (data.abandonedRepos||[]).length + '</div><div class="repo-stat-label">Abandoned</div></div>';
  html += '</div>';
  if (data.gaps && data.gaps.length) {
    html += '<div class="section"><h4>Gap Clusters</h4>';
    for (const gap of data.gaps) {
      html += '<div class="gap-card">';
      html += '<div class="gap-card-header"><span class="gap-theme">' + esc(gap.theme) + '</span><span class="gap-score">Score: ' + Math.round(gap.gapScore) + '</span></div>';
      html += '<div class="gap-meta"><span class="meta-item"><strong>' + gap.issueCount + '</strong> issues</span><span class="meta-item"><strong>' + gap.totalReactions + '</strong> reactions</span><span class="meta-item"><strong>' + gap.affectedRepos.length + '</strong> repos</span><span class="meta-item">avg age <strong>' + gap.avgAgeDays + 'd</strong></span></div>';
      if (gap.keywords && gap.keywords.length) html += '<div class="keywords">' + gap.keywords.map(function(k) { return '<span class="kw-tag">' + esc(k) + '</span>'; }).join('') + '</div>';
      html += '<div class="issues-list">' + (gap.sampleIssues||[]).map(function(i) { return '<a class="issue-link" href="' + safeUrl(i.url) + '" target="_blank"><span class="reactions-badge">👍 ' + i.reactions + '</span>' + esc(i.title.slice(0,80)) + '</a>'; }).join('') + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }
  if (data.repos && data.repos.length) {
    html += '<div class="section"><h4>Repositories (' + data.repos.length + ')</h4>';
    html += '<table><thead><tr><th>Repo</th><th>Stars</th><th>Open Issues</th><th>Last Pushed</th><th>Status</th></tr></thead><tbody>';
    for (const r of data.repos) {
      const d = r.lastPushed ? new Date(r.lastPushed).toLocaleDateString() : 'N/A';
      html += '<tr>';
      html += '<td><a href="https://github.com/' + esc(r.fullName) + '" target="_blank">' + esc(r.fullName) + '</a></td>';
      html += '<td>' + (r.stars||0).toLocaleString() + '</td>';
      html += '<td>' + (r.openIssues||0) + '</td>';
      html += '<td>' + d + '</td>';
      html += '<td>' + (r.isAbandoned ? '<span class="stale-badge">abandoned</span>' : '<span style="color:#4ade80;font-size:11px">active</span>') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

// load picked issues on startup
window.addEventListener('DOMContentLoaded', function() { renderPickedIssues(); });
</script>
</body>
</html>`;

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log("GapScout UI running at http://localhost:3000");
});
