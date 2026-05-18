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

app.get("/api/count-issues", async (c) => {
  try {
    const language = c.req.query("language") ?? "";
    const topic = c.req.query("topic") ?? "";
    if (!language && !topic) return c.json({ error: "Provide a language or topic." }, 400);
    const totalCount = await github.countIssues(language, topic || undefined);
    return c.json({ totalCount });
  } catch (e: any) {
    return safeError(e, "count-issues");
  }
});

app.post("/api/trending-issues", async (c) => {
  try {
    const body = await c.req.json();
    const language = String(body.language ?? "");
    const topic = body.topic ? String(body.topic) : undefined;
    const tf = body.timeframe;
    const timeframe: "daily" | "weekly" | "monthly" =
      tf === "daily" || tf === "weekly" || tf === "monthly" ? tf : "weekly";
    const limits = { daily: 20, weekly: 30, monthly: 50 };
    if (!language && !topic) return c.json({ error: "Provide a language or topic." }, 400);
    const issues = await github.fetchTrendingIssues(language, topic, timeframe, limits[timeframe]);
    return c.json({ issues, timeframe, totalShown: issues.length });
  } catch (e: any) {
    return safeError(e, "trending-issues");
  }
});

app.post("/api/analyse", async (c) => {
  try {
    const body = await c.req.json();
    const { apiKey, provider, model, repo, issueTitle, issueBody, labels } = body;
    if (!apiKey || !provider || !repo || !issueTitle) {
      return c.json({ error: "Missing required fields." }, 400);
    }

    const meta = await github.fetchRepoMeta(String(repo));

    const prompt =
      `You are a developer assistant. Analyse this GitHub issue concisely.\n\n` +
      `Repo: ${repo}\n` +
      `Repo description: ${meta.description || "Not available"}\n` +
      `Languages: ${meta.languages.length ? meta.languages.join(", ") : "Not available"}\n` +
      `Issue title: ${issueTitle}\n` +
      `Issue body: ${String(issueBody ?? "").slice(0, 500)}\n` +
      `Labels: ${(labels ?? []).join(", ") || "None"}\n\n` +
      `Reply in exactly this format:\n` +
      `**Product:** [1-2 sentences on what this repo does]\n` +
      `**Languages:** [comma-separated list]\n` +
      `**Issue Summary:** [2-3 sentences on the problem and what solving it would require]`;

    let summary = "";

    if (provider === "claude") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": String(apiKey),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: String(model || "claude-sonnet-4-6"),
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data: any = await res.json();
      if (!res.ok) return c.json({ error: data.error?.message ?? "Claude API error" }, 400);
      summary = data.content?.[0]?.text ?? "";
    } else if (provider === "openai" || provider === "openrouter") {
      const baseUrl =
        provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.openai.com/v1";
      const defaultModel = provider === "openrouter" ? "deepseek/deepseek-chat" : "gpt-4o";
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(provider === "openrouter"
            ? { "HTTP-Referer": "https://github.com/sowmyaarajan/gapscout" }
            : {}),
        },
        body: JSON.stringify({
          model: String(model || defaultModel),
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data: any = await res.json();
      if (!res.ok) return c.json({ error: data.error?.message ?? "API error" }, 400);
      summary = data.choices?.[0]?.message?.content ?? "";
    } else {
      return c.json({ error: "Unknown provider." }, 400);
    }

    return c.json({ summary });
  } catch (e: any) {
    return safeError(e, "analyse");
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
.insights-panel{background:linear-gradient(135deg,#1e1b4b,#1e293b);border:1px solid #4f46e5;border-radius:12px;padding:20px 24px;margin-bottom:20px}
.insights-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.insights-title{font-size:12px;font-weight:700;color:#a5b4fc;text-transform:uppercase;letter-spacing:.08em}
.insights-stats{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px}
.insights-stat-val{font-size:26px;font-weight:800;color:#a5b4fc;font-family:'JetBrains Mono',monospace;display:block}
.insights-stat-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
.insights-top{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
.insights-row{display:flex;align-items:center;gap:10px;font-size:13px}
.insights-rank{color:#6366f1;font-weight:700;width:18px;flex-shrink:0}
.insights-label{color:#e2e8f0;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.insights-meta{font-size:11px;color:#64748b;white-space:nowrap}
.insights-takeaway{font-size:12px;color:#94a3b8;border-top:1px solid #334155;padding-top:10px;line-height:1.6}
.insights-takeaway strong{color:#c4b5fd}
.btn-report{background:transparent;border:1px solid #4f46e5;color:#a5b4fc;font-size:11px;font-weight:600;padding:5px 12px;border-radius:6px;cursor:pointer;white-space:nowrap}
.btn-report:hover{background:#4f46e5;color:#fff}
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
.search-bar{display:flex;gap:16px;align-items:flex-end;margin-bottom:20px;flex-wrap:wrap}
.search-bar .form-group{flex:1;min-width:160px}
.issue-count-display{font-size:26px;font-weight:800;color:#f1f5f9;margin-bottom:16px}
.issue-count-display span{color:#3b82f6;font-family:'JetBrains Mono',monospace}
.timeframe-bar{display:flex;gap:8px;align-items:center;margin-bottom:20px;flex-wrap:wrap}
.tf-btn{background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:8px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
.tf-btn:hover{background:#334155;color:#e2e8f0;border-color:#6366f1}
.tf-btn.active{background:#4f46e5;border-color:#4f46e5;color:#fff}
.trend-card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;margin-bottom:10px}
.trend-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
.trend-card-title{font-size:14px;font-weight:600;color:#f1f5f9;line-height:1.4;flex:1;text-decoration:none}
.trend-card-title:hover{color:#60a5fa;text-decoration:none}
.trend-card-meta{display:flex;gap:12px;font-size:12px;color:#64748b;flex-wrap:wrap;margin-bottom:10px;align-items:center}
.btn-analyse{background:#7c3aed;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap}
.btn-analyse:hover:not(:disabled){background:#6d28d9}
.btn-analyse:disabled{background:#334155;color:#64748b;cursor:default}
.analysis-box{margin-top:12px;padding:12px 14px;background:#0f172a;border-radius:8px;border-left:3px solid #7c3aed;font-size:13px;color:#94a3b8;line-height:1.7;display:none}
.analysis-box.show{display:block}
.analysis-box strong{color:#c4b5fd}
.settings-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100;align-items:center;justify-content:center}
.settings-overlay.open{display:flex}
.settings-panel{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;width:460px;max-width:92vw}
.btn-settings{margin-left:auto;background:transparent;border:1px solid #334155;color:#94a3b8;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer}
.btn-settings:hover{border-color:#6366f1;color:#a5b4fc}
</style>
</head>
<body>
<header>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
  <h1>GapScout</h1>
  <span>v0.3.0</span>
  <button class="btn-settings" onclick="openSettings()">&#9881; AI Settings</button>
</header>

<!-- SETTINGS OVERLAY -->
<div id="settings-overlay" class="settings-overlay">
  <div class="settings-panel">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <h3 style="font-size:16px;font-weight:700;color:#f1f5f9">AI Settings</h3>
      <button onclick="closeSettings()" style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1">&#x2715;</button>
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label>Provider</label>
      <select id="ai-provider" onchange="onProviderChange()">
        <option value="claude">Claude (Anthropic)</option>
        <option value="openai">OpenAI</option>
        <option value="openrouter">OpenRouter (DeepSeek / any model)</option>
      </select>
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label>API Key</label>
      <input id="ai-key" type="password" placeholder="Enter your API key…"/>
    </div>
    <div class="form-group" style="margin-bottom:24px">
      <label>Model <span style="color:#475569;font-size:11px;text-transform:none;letter-spacing:0">(editable)</span></label>
      <input id="ai-model" placeholder="claude-sonnet-4-6"/>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn" onclick="saveSettings()">Save</button>
      <button class="btn btn-sm" onclick="closeSettings()">Cancel</button>
      <span id="settings-saved" style="display:none;color:#4ade80;font-size:13px;margin-left:8px">&#10003; Saved</span>
    </div>
  </div>
</div>
<div class="container">
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('find-gaps')">Find Gaps</button>
    <button class="tab-btn" onclick="switchTab('opportunities')">Opportunities</button>
    <button class="tab-btn" onclick="switchTab('search-issues')">Search Issues</button>
    <button class="tab-btn" onclick="switchTab('analyze-repo')">Analyze Repo</button>
    <button class="tab-btn" onclick="switchTab('organization')">Organization</button>
    <button class="tab-btn" onclick="switchTab('abandoned')">Abandoned Repos</button>
  </div>

  <!-- FIND GAPS (REDESIGNED) -->
  <div id="tab-find-gaps" class="tab-panel active">
    <div class="search-bar">
      <div class="form-group"><label>Language</label><input id="fg-lang" placeholder="python, rust, typescript…" onkeydown="if(event.key==='Enter')runGapsSearch()"/></div>
      <div class="form-group"><label>Topic <span style="color:#475569;font-size:11px;text-transform:none;letter-spacing:0">(optional)</span></label><input id="fg-topic" placeholder="machine-learning, agents, llm…" onkeydown="if(event.key==='Enter')runGapsSearch()"/></div>
      <div><button id="btn-fg" class="btn" onclick="runGapsSearch()">Search</button></div>
    </div>
    <div id="fg-spinner" class="spinner">Searching GitHub…</div>
    <div id="fg-error" class="error-box"></div>
    <div id="fg-count-section" style="display:none;margin-top:8px">
      <div id="fg-count-display" class="issue-count-display"></div>
      <div class="timeframe-bar">
        <span style="font-size:13px;color:#64748b;margin-right:4px">Trending:</span>
        <button class="tf-btn" id="tf-daily" onclick="loadTrending('daily',this)">Daily — Top 20</button>
        <button class="tf-btn" id="tf-weekly" onclick="loadTrending('weekly',this)">Weekly — Top 30</button>
        <button class="tf-btn" id="tf-monthly" onclick="loadTrending('monthly',this)">Monthly — Top 50</button>
      </div>
      <div id="fg-trending-spinner" class="spinner" style="display:none">Loading trending issues…</div>
    </div>
    <div id="fg-results" style="margin-top:8px"></div>
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
let lastSearchType = '';
let lastSearchLabel = '';

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

function stat(val, label) {
  return '<div><span class="insights-stat-val">' + val + '</span><span class="insights-stat-label">' + label + '</span></div>';
}

function renderSummaryPanel(data, type, searchLabel) {
  var html = '<div class="insights-panel">';
  html += '<div class="insights-header"><span class="insights-title">Key Insights — ' + esc(searchLabel) + '</span>';
  html += '<button class="btn-report" onclick="downloadReport()">&#11015; Download Report</button></div>';
  html += '<div class="insights-stats">';
  if (type === 'gaps') {
    html += stat(data.reposAnalyzed || 0, 'Repos');
    html += stat((data.issuesAnalyzed || 0).toLocaleString(), 'Issues');
    html += stat(data.featureRequestsFound || 0, 'Feature Reqs');
    html += stat((data.gaps || []).length, 'Gaps Found');
    html += '</div>';
    var top3 = (data.gaps || []).slice(0, 3);
    if (top3.length) {
      html += '<div class="insights-top">';
      top3.forEach(function(g, i) {
        var cls = g.worthBuilding ? (g.worthBuilding.verdict === 'Strong opportunity' ? 'strong' : g.worthBuilding.verdict === 'Promising' ? 'promising' : g.worthBuilding.verdict === 'Niche' ? 'niche' : 'saturated') : '';
        html += '<div class="insights-row"><span class="insights-rank">' + (i+1) + '</span><span class="insights-label">' + esc(g.theme) + '</span>';
        if (g.worthBuilding) html += '<span class="wb-badge ' + cls + ' insights-meta">' + esc(g.worthBuilding.verdict) + '</span>';
        html += '<span class="insights-meta">score ' + g.gapScore + '</span></div>';
      });
      html += '</div>';
      var best = top3[0];
      var takeaway = best.worthBuilding ? best.worthBuilding.reasoning : (best.issueCount + ' issues, ' + best.totalReactions + ' reactions');
      html += '<div class="insights-takeaway">Strongest gap: <strong>' + esc(best.theme) + '</strong> — ' + esc(takeaway) + '</div>';
    }
  } else if (type === 'opportunities' || type === 'issues') {
    html += stat(data.reposSearched || data.reposAnalyzed || 0, 'Repos');
    html += stat(data.totalFound || (data.issues || []).length, 'Found');
    html += '</div>';
    var top3 = (data.issues || []).slice(0, 3);
    if (top3.length) {
      html += '<div class="insights-top">';
      top3.forEach(function(issue, i) {
        html += '<div class="insights-row"><span class="insights-rank">' + (i+1) + '</span><span class="insights-label">' + esc(issue.title.slice(0,60)) + '</span><span class="insights-meta">&#128077; ' + issue.reactions + ' · ' + issue.ageDays + 'd</span></div>';
      });
      html += '</div>';
      var best = top3[0];
      html += '<div class="insights-takeaway">Most in-demand: <strong>' + esc(best.title.slice(0,60)) + '</strong> — ' + best.reactions + ' reactions, open ' + best.ageDays + ' days</div>';
    }
  } else if (type === 'repo') {
    html += stat((data.stars || 0).toLocaleString(), 'Stars');
    html += stat(data.openIssues || 0, 'Open Issues');
    html += stat((data.staleIssues || []).length, 'Stale');
    html += stat((data.gaps || []).length, 'Clusters');
    html += '</div>';
    var top3 = (data.topIssues || []).slice(0, 3);
    if (top3.length) {
      html += '<div class="insights-top">';
      top3.forEach(function(issue, i) {
        html += '<div class="insights-row"><span class="insights-rank">' + (i+1) + '</span><span class="insights-label">' + esc(issue.title.slice(0,60)) + '</span><span class="insights-meta">&#128077; ' + issue.reactions + '</span></div>';
      });
      html += '</div>';
      var best = top3[0];
      html += '<div class="insights-takeaway">Most requested: <strong>' + esc(best.title.slice(0,60)) + '</strong> — ' + best.reactions + ' reactions</div>';
    }
  } else if (type === 'org') {
    html += stat(data.reposFound || 0, 'Repos');
    html += stat((data.issuesAnalyzed || 0).toLocaleString(), 'Issues');
    html += stat((data.gaps || []).length, 'Gaps');
    html += stat((data.abandonedRepos || []).length, 'Abandoned');
    html += '</div>';
    var top3 = (data.gaps || []).slice(0, 3);
    if (top3.length) {
      html += '<div class="insights-top">';
      top3.forEach(function(g, i) {
        html += '<div class="insights-row"><span class="insights-rank">' + (i+1) + '</span><span class="insights-label">' + esc(g.theme) + '</span><span class="insights-meta">score ' + Math.round(g.gapScore) + '</span></div>';
      });
      html += '</div>';
      var best = top3[0];
      var takeaway = best.worthBuilding ? best.worthBuilding.reasoning : (best.issueCount + ' issues across ' + best.affectedRepos.length + ' repos');
      html += '<div class="insights-takeaway">Strongest gap: <strong>' + esc(best.theme) + '</strong> — ' + esc(takeaway) + '</div>';
    }
  } else if (type === 'abandoned') {
    html += stat(data.reposChecked || 0, 'Checked');
    html += stat(data.abandonedCount || 0, 'Abandoned');
    html += '</div>';
    var top3 = (data.abandoned || []).slice(0, 3);
    if (top3.length) {
      html += '<div class="insights-top">';
      top3.forEach(function(r, i) {
        html += '<div class="insights-row"><span class="insights-rank">' + (i+1) + '</span><span class="insights-label">' + esc(r.repo) + '</span><span class="insights-meta">&#11088; ' + (r.stars||0).toLocaleString() + '</span></div>';
      });
      html += '</div>';
      var best = top3[0];
      html += '<div class="insights-takeaway">Most popular abandoned: <strong>' + esc(best.repo) + '</strong> — ' + (best.stars||0).toLocaleString() + ' stars, last active ' + new Date(best.lastPushed).toLocaleDateString() + '</div>';
    }
  }
  html += '</div>';
  return html;
}

function generateHtmlReport(data, type, searchLabel) {
  var date = new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
  var css = 'body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:0}'
    + 'header{background:#1e1b4b;border-bottom:1px solid #4f46e5;padding:20px 40px;display:flex;align-items:center;gap:16px}'
    + 'header h1{font-size:22px;font-weight:800;color:#a5b4fc;margin:0}'
    + 'header .sub{font-size:13px;color:#64748b}'
    + '.container{max-width:1100px;margin:0 auto;padding:32px 40px}'
    + '.summary-box{background:linear-gradient(135deg,#1e1b4b,#1e293b);border:1px solid #4f46e5;border-radius:12px;padding:24px;margin-bottom:28px}'
    + '.summary-box h2{font-size:14px;font-weight:700;color:#a5b4fc;text-transform:uppercase;letter-spacing:.08em;margin:0 0 16px}'
    + '.stat-grid{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px}'
    + '.stat-box{text-align:center}'
    + '.stat-val{font-size:28px;font-weight:800;color:#a5b4fc;font-family:monospace;display:block}'
    + '.stat-lbl{font-size:11px;color:#64748b;text-transform:uppercase}'
    + '.section{margin-bottom:28px}'
    + '.section h2{font-size:15px;font-weight:700;color:#94a3b8;border-bottom:1px solid #1e293b;padding-bottom:8px;margin-bottom:16px}'
    + '.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;margin-bottom:12px}'
    + '.card-title{font-size:16px;font-weight:700;color:#f1f5f9;font-family:monospace;margin-bottom:8px}'
    + '.meta{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:#64748b;margin-bottom:8px}'
    + '.badge-strong{background:#14532d;color:#86efac;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}'
    + '.badge-promising{background:#1e3a5f;color:#93c5fd;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}'
    + '.badge-niche{background:#3d2900;color:#fcd34d;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}'
    + '.badge-saturated{background:#1e1e2e;color:#64748b;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}'
    + 'th{text-align:left;padding:10px 12px;border-bottom:2px solid #334155;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase}'
    + 'td{padding:10px 12px;border-bottom:1px solid #1e293b;vertical-align:top}'
    + 'a{color:#60a5fa;text-decoration:none}'
    + '.stale{background:#451a03;color:#fb923c;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px}'
    + 'footer{border-top:1px solid #1e293b;padding:20px 40px;text-align:center;font-size:12px;color:#475569}';

  var esc2 = function(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var safeHref = function(url) {
    try { var p = new URL(url); return (p.hostname === 'github.com' && p.protocol === 'https:') ? esc2(url) : '#'; } catch(e) { return '#'; }
  };

  var body = '';
  body += '<div class="summary-box"><h2>Executive Summary</h2><div class="stat-grid">';
  if (type === 'gaps') {
    body += '<div class="stat-box"><span class="stat-val">' + (data.reposAnalyzed||0) + '</span><span class="stat-lbl">Repos</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.issuesAnalyzed||0).toLocaleString() + '</span><span class="stat-lbl">Issues</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.featureRequestsFound||0) + '</span><span class="stat-lbl">Feature Reqs</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.gaps||[]).length + '</span><span class="stat-lbl">Gaps</span></div>';
  } else if (type === 'opportunities' || type === 'issues') {
    body += '<div class="stat-box"><span class="stat-val">' + (data.reposSearched||0) + '</span><span class="stat-lbl">Repos</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.totalFound||0) + '</span><span class="stat-lbl">Issues Found</span></div>';
  } else if (type === 'repo') {
    body += '<div class="stat-box"><span class="stat-val">' + (data.stars||0).toLocaleString() + '</span><span class="stat-lbl">Stars</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.openIssues||0) + '</span><span class="stat-lbl">Open Issues</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.staleIssues||[]).length + '</span><span class="stat-lbl">Stale</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.gaps||[]).length + '</span><span class="stat-lbl">Gap Clusters</span></div>';
  } else if (type === 'org') {
    body += '<div class="stat-box"><span class="stat-val">' + (data.reposFound||0) + '</span><span class="stat-lbl">Repos</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.issuesAnalyzed||0).toLocaleString() + '</span><span class="stat-lbl">Issues</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.gaps||[]).length + '</span><span class="stat-lbl">Gaps</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.abandonedRepos||[]).length + '</span><span class="stat-lbl">Abandoned</span></div>';
  } else if (type === 'abandoned') {
    body += '<div class="stat-box"><span class="stat-val">' + (data.reposChecked||0) + '</span><span class="stat-lbl">Checked</span></div>';
    body += '<div class="stat-box"><span class="stat-val">' + (data.abandonedCount||0) + '</span><span class="stat-lbl">Abandoned</span></div>';
  }
  body += '</div></div>';

  if (type === 'gaps' || type === 'org') {
    if (data.gaps && data.gaps.length) {
      body += '<div class="section"><h2>Gap Analysis</h2>';
      data.gaps.forEach(function(gap) {
        var wb = gap.worthBuilding;
        var vcls = wb ? (wb.verdict === 'Strong opportunity' ? 'badge-strong' : wb.verdict === 'Promising' ? 'badge-promising' : wb.verdict === 'Niche' ? 'badge-niche' : 'badge-saturated') : '';
        body += '<div class="card"><div class="card-title">' + esc2(gap.theme) + (wb ? ' <span class="' + vcls + '">' + esc2(wb.verdict) + '</span> <span style="color:#94a3b8;font-size:13px">' + wb.overall + '/100</span>' : '') + '</div>';
        body += '<div class="meta"><span>' + gap.issueCount + ' issues</span><span>' + gap.totalReactions + ' reactions</span><span>' + (gap.affectedRepos||[]).length + ' repos</span><span>avg ' + gap.avgAgeDays + 'd old</span></div>';
        if (wb) body += '<div style="font-size:12px;color:#64748b;margin-bottom:8px">' + esc2(wb.reasoning) + '</div>';
        if (gap.registrySignal && gap.registrySignal.totalMonthlyDownloads > 0) {
          var dl = gap.registrySignal.totalMonthlyDownloads;
          var dlStr = dl >= 1000000 ? (dl/1000000).toFixed(1)+'M' : dl >= 1000 ? Math.round(dl/1000)+'k' : String(dl);
          body += '<div style="font-size:12px;color:#64748b;margin-bottom:8px">&#128230; ' + dlStr + ' downloads/mo via ' + esc2(gap.registrySignal.registry) + '</div>';
        }
        if (gap.sampleIssues && gap.sampleIssues.length) {
          body += '<div style="font-size:12px;color:#94a3b8;margin-top:8px;margin-bottom:4px">Sample issues:</div>';
          gap.sampleIssues.forEach(function(i) {
            body += '<div style="padding:3px 0"><a href="' + safeHref(i.url) + '">' + esc2(i.title.slice(0,90)) + '</a> <span style="color:#64748b">&#128077; ' + i.reactions + '</span></div>';
          });
        }
        body += '</div>';
      });
      body += '</div>';
    }
    if (type === 'org' && data.repos && data.repos.length) {
      body += '<div class="section"><h2>Repositories</h2><table><thead><tr><th>Repo</th><th>Stars</th><th>Open Issues</th><th>Last Pushed</th><th>Status</th></tr></thead><tbody>';
      data.repos.forEach(function(r) {
        var d = r.lastPushed ? new Date(r.lastPushed).toLocaleDateString() : 'N/A';
        body += '<tr><td><a href="https://github.com/' + esc2(r.fullName) + '">' + esc2(r.fullName) + '</a></td><td>' + (r.stars||0).toLocaleString() + '</td><td>' + (r.openIssues||0) + '</td><td>' + d + '</td><td>' + (r.isAbandoned ? '<span class="stale">abandoned</span>' : 'active') + '</td></tr>';
      });
      body += '</tbody></table></div>';
    }
  } else if (type === 'opportunities' || type === 'issues') {
    if (data.issues && data.issues.length) {
      body += '<div class="section"><h2>Issues</h2><table><thead><tr><th>Repo</th><th>Title</th><th>Age</th><th>Reactions</th><th>Participants</th></tr></thead><tbody>';
      data.issues.forEach(function(i) {
        body += '<tr><td style="font-family:monospace;font-size:11px">' + esc2(i.repo) + '</td><td><a href="' + safeHref(i.url) + '">' + esc2(i.title.slice(0,80)) + '</a>' + (i.isStale ? ' <span class="stale">stale</span>' : '') + '</td><td>' + i.ageDays + 'd</td><td>' + i.reactions + '</td><td>' + i.participantCount + '</td></tr>';
      });
      body += '</tbody></table></div>';
    }
  } else if (type === 'repo') {
    if (data.topIssues && data.topIssues.length) {
      body += '<div class="section"><h2>Top Issues by Demand</h2><table><thead><tr><th>Title</th><th>Reactions</th><th>Age</th></tr></thead><tbody>';
      data.topIssues.forEach(function(i) {
        body += '<tr><td><a href="' + safeHref(i.url) + '">' + esc2(i.title.slice(0,90)) + '</a></td><td>' + i.reactions + '</td><td>' + i.ageDays + 'd</td></tr>';
      });
      body += '</tbody></table></div>';
    }
    if (data.staleIssues && data.staleIssues.length) {
      body += '<div class="section"><h2>Stale Issues</h2><table><thead><tr><th>Title</th><th>Age</th><th>Reactions</th></tr></thead><tbody>';
      data.staleIssues.slice(0,20).forEach(function(i) {
        body += '<tr><td><a href="' + safeHref(i.url) + '">' + esc2(i.title.slice(0,80)) + '</a></td><td>' + i.ageDays + 'd</td><td>' + i.reactions + '</td></tr>';
      });
      body += '</tbody></table></div>';
    }
    if (data.gaps && data.gaps.length) {
      body += '<div class="section"><h2>Gap Clusters</h2>';
      data.gaps.forEach(function(gap) {
        body += '<div class="card"><div class="card-title">' + esc2(gap.theme) + '</div>';
        body += '<div class="meta"><span>' + gap.issueCount + ' issues</span><span>' + gap.totalReactions + ' reactions</span></div></div>';
      });
      body += '</div>';
    }
  } else if (type === 'abandoned') {
    if (data.abandoned && data.abandoned.length) {
      body += '<div class="section"><h2>Abandoned Repositories</h2><table><thead><tr><th>Repo</th><th>Stars</th><th>Last Pushed</th><th>Open Issues</th></tr></thead><tbody>';
      data.abandoned.forEach(function(r) {
        var d = new Date(r.lastPushed).toLocaleDateString();
        body += '<tr><td><a href="https://github.com/' + esc2(r.repo) + '">' + esc2(r.repo) + '</a></td><td>' + (r.stars||0).toLocaleString() + '</td><td>' + d + '</td><td>' + r.openIssues + '</td></tr>';
      });
      body += '</tbody></table></div>';
    }
  }

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GapScout Report — ' + esc2(searchLabel) + '</title><style>' + css + '</style></head>'
    + '<body><header><h1>GapScout</h1><div class="sub">' + esc2(searchLabel) + ' · Generated ' + date + '</div></header>'
    + '<div class="container">' + body + '</div>'
    + '<footer>Generated by GapScout · github.com/sowmyaarajan/gapscout</footer></body></html>';
}

function downloadReport() {
  if (!lastResult) return;
  var html = generateHtmlReport(lastResult, lastSearchType, lastSearchLabel);
  var blob = new Blob([html], {type: 'text/html'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  var slug = lastSearchLabel.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  a.download = 'gapscout-' + slug + '-' + new Date().toISOString().slice(0, 10) + '.html';
  a.click();
  URL.revokeObjectURL(url);
}

// ── FIND GAPS — 3-STEP FLOW ─────────────────────────────────────
var _trendingLang = '';
var _trendingTopic = '';
var _trendingIssues = [];

async function runGapsSearch() {
  clearError('fg');
  const lang = document.getElementById('fg-lang').value.trim();
  const topic = document.getElementById('fg-topic').value.trim();
  if (!lang && !topic) { showError('fg', 'Provide a language or topic (e.g. python, machine-learning)'); return; }
  _trendingLang = lang;
  _trendingTopic = topic;
  setLoading('fg', true);
  document.getElementById('fg-count-section').style.display = 'none';
  document.getElementById('fg-results').innerHTML = '';
  try {
    const params = new URLSearchParams();
    if (lang) params.set('language', lang);
    if (topic) params.set('topic', topic);
    const res = await fetch('/api/count-issues?' + params.toString());
    const data = await res.json();
    if (data.error) { showError('fg', data.error); return; }
    document.getElementById('fg-count-display').innerHTML =
      'Found <span>' + data.totalCount.toLocaleString() + '</span> open issues on GitHub';
    document.getElementById('fg-count-section').style.display = 'block';
    // auto-load weekly by default
    loadTrending('weekly', document.getElementById('tf-weekly'));
  } catch(e) { showError('fg', e.message); }
  finally { setLoading('fg', false); }
}

async function loadTrending(timeframe, btn) {
  document.querySelectorAll('.tf-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  const spinner = document.getElementById('fg-trending-spinner');
  spinner.style.display = 'block';
  document.getElementById('fg-results').innerHTML = '';
  try {
    const res = await fetch('/api/trending-issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: _trendingLang, topic: _trendingTopic, timeframe: timeframe }),
    });
    const data = await res.json();
    if (data.error) { showError('fg', data.error); spinner.style.display = 'none'; return; }
    lastResult = data;
    lastSearchType = 'issues';
    lastSearchLabel = _trendingLang || _trendingTopic || 'search';
    _trendingIssues = data.issues || [];
    renderTrendingIssues(_trendingIssues, timeframe);
  } catch(e) { showError('fg', e.message); }
  finally { spinner.style.display = 'none'; }
}

function renderTrendingIssues(issues, timeframe) {
  const el = document.getElementById('fg-results');
  if (!issues || !issues.length) {
    el.innerHTML = '<p style="color:#64748b">No trending issues found for this timeframe. Try Weekly or Monthly.</p>';
    return;
  }
  const label = timeframe === 'daily' ? 'today' : timeframe === 'weekly' ? 'this week' : 'this month';
  const aiSettings = JSON.parse(localStorage.getItem('gapscout-ai-settings') || '{}');
  const hasKey = !!aiSettings.apiKey;
  var html = '<p style="color:#64748b;font-size:13px;margin-bottom:16px">Top ' + issues.length + ' issues trending ' + label + ' · sorted by reactions</p>';
  issues.forEach(function(issue, idx) {
    html += '<div class="trend-card" id="tc-' + idx + '">';
    html += '<div class="trend-card-header">';
    html += '<a class="trend-card-title" href="' + safeUrl(issue.url) + '" target="_blank">' + esc(issue.title.slice(0, 100)) + '</a>';
    if (hasKey) {
      html += '<button class="btn-analyse" onclick="analyseIssue(' + idx + ', this)">Analyse</button>';
    } else {
      html += '<button class="btn-analyse" disabled title="Configure AI key in &#9881; AI Settings">Analyse</button>';
    }
    html += '</div>';
    html += '<div class="trend-card-meta">';
    html += '<span style="font-family:monospace;font-size:11px;color:#3b82f6">' + esc(issue.repo) + '</span>';
    html += '<span>&#128077; ' + issue.reactions + '</span>';
    html += '<span>&#128336; ' + issue.ageDays + 'd old</span>';
    html += '<span>&#128172; ' + issue.comments + '</span>';
    if (issue.isStale) html += '<span class="stale-badge">stale</span>';
    var labelTags = (issue.labels || []).slice(0, 3).map(function(l) { return '<span class="label-tag">' + esc(l) + '</span>'; }).join('');
    if (labelTags) html += labelTags;
    html += '</div>';
    html += '<div class="analysis-box" id="abox-' + idx + '"></div>';
    html += '</div>';
  });
  el.innerHTML = html;
}

async function analyseIssue(idx, btn) {
  const issue = _trendingIssues[idx];
  if (!issue) return;
  const aiSettings = JSON.parse(localStorage.getItem('gapscout-ai-settings') || '{}');
  if (!aiSettings.apiKey) { alert('Please configure your AI key in ⚙ AI Settings first.'); return; }
  btn.textContent = 'Analysing…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: aiSettings.apiKey,
        provider: aiSettings.provider || 'claude',
        model: aiSettings.model || '',
        repo: issue.repo,
        issueTitle: issue.title,
        issueBody: issue.body || '',
        labels: issue.labels || [],
      }),
    });
    const data = await res.json();
    if (data.error) { btn.textContent = 'Analyse'; btn.disabled = false; alert('Error: ' + data.error); return; }
    const box = document.getElementById('abox-' + idx);
    box.innerHTML = data.summary
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    box.classList.add('show');
    btn.textContent = 'Analysed ✓';
  } catch(e) {
    btn.textContent = 'Analyse';
    btn.disabled = false;
    alert('Analysis failed: ' + e.message);
  }
}

// ── AI SETTINGS ─────────────────────────────────────────────────
var PROVIDER_MODELS = { claude: 'claude-sonnet-4-6', openai: 'gpt-4o', openrouter: 'deepseek/deepseek-chat' };

function openSettings() {
  const s = JSON.parse(localStorage.getItem('gapscout-ai-settings') || '{}');
  document.getElementById('ai-provider').value = s.provider || 'claude';
  document.getElementById('ai-key').value = s.apiKey || '';
  document.getElementById('ai-model').value = s.model || PROVIDER_MODELS[s.provider || 'claude'];
  document.getElementById('settings-saved').style.display = 'none';
  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

function onProviderChange() {
  const p = document.getElementById('ai-provider').value;
  document.getElementById('ai-model').value = PROVIDER_MODELS[p] || '';
}

function saveSettings() {
  const settings = {
    provider: document.getElementById('ai-provider').value,
    apiKey: document.getElementById('ai-key').value.trim(),
    model: document.getElementById('ai-model').value.trim(),
  };
  localStorage.setItem('gapscout-ai-settings', JSON.stringify(settings));
  document.getElementById('settings-saved').style.display = 'inline';
  setTimeout(closeSettings, 1200);
}

function renderGaps(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.gaps || !data.gaps.length) { el.innerHTML = '<p style="color:#64748b">No gaps found.</p>'; return; }
  let html = renderSummaryPanel(data, lastSearchType, lastSearchLabel);
  html += resultsHeader('Gaps Found', data.gaps.length);
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
    lastSearchType = 'issues';
    lastSearchLabel = [lang, topic, kw].filter(Boolean).join(' ') || 'search';
    renderIssuesTable('si-results', data);
  } catch(e) { showError('si', e.message); }
  finally { setLoading('si', false); }
}

function renderIssuesTable(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.issues || !data.issues.length) { el.innerHTML = '<p style="color:#64748b">No issues found matching filters.</p>'; return; }
  let html = renderSummaryPanel(data, lastSearchType, lastSearchLabel);
  html += resultsHeader('Issues Found', data.totalFound);
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
    lastSearchType = 'repo';
    lastSearchLabel = repo;
    renderRepoAnalysis('ar-results', data);
  } catch(e) { showError('ar', e.message); }
  finally { setLoading('ar', false); }
}

function renderRepoAnalysis(containerId, d) {
  const el = document.getElementById(containerId);
  let html = renderSummaryPanel(d, lastSearchType, lastSearchLabel);
  html += '<div class="results-header"><h3>' + esc(d.repo) + '</h3><button class="btn btn-sm" onclick="doExport()">Export JSON</button></div>';
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
    lastSearchType = 'abandoned';
    lastSearchLabel = lang || topic || 'repos';
    renderAbandoned('ab-results', data);
  } catch(e) { showError('ab', e.message); }
  finally { setLoading('ab', false); }
}

function renderAbandoned(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.abandoned || !data.abandoned.length) { el.innerHTML = '<p style="color:#64748b">No abandoned repos found in top ' + data.reposChecked + '.</p>'; return; }
  let html = renderSummaryPanel(data, lastSearchType, lastSearchLabel);
  html += resultsHeader('Abandoned Repos', data.abandonedCount);
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
    lastSearchType = 'opportunities';
    lastSearchLabel = lang || topic || 'search';
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
  let html = renderSummaryPanel(lastResult || {reposSearched:0,totalFound:opportunities.length,issues:opportunities}, lastSearchType, lastSearchLabel);
  html += '<p style="color:#64748b;font-size:13px;margin-bottom:16px">' + opportunities.length + ' opportunities found</p>';
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
    lastSearchType = 'org';
    lastSearchLabel = org;
    renderOrgAnalysis('og-results', data);
  } catch(e) { showError('og', e.message); }
  finally { setLoading('og', false); }
}

function renderOrgAnalysis(containerId, data) {
  const el = document.getElementById(containerId);
  let html = renderSummaryPanel(data, lastSearchType, lastSearchLabel);
  html += resultsHeader(esc(data.org) + ' Organization', data.reposFound + ' repos');
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
