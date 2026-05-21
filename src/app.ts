import { Hono } from "hono";
import { cors } from "hono/cors";
import { GitHubClient } from "./github.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var is required");
  process.exit(1);
}

const github = new GitHubClient(token);
const app = new Hono();

app.use("*", cors({
  origin: "*",
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

function safeError(e: any, context: string) {
  console.error(`[GapScout] ${context}:`, e?.message ?? e);
  return { error: "Request failed. Check server logs." };
}

app.get("/api/count-issues", async (c) => {
  try {
    const language = c.req.query("language") ?? "";
    const topic = c.req.query("topic") ?? "";
    if (!language && !topic) return c.json({ error: "Provide a language or topic." }, 400);
    const totalCount = await github.countIssues(language, topic || undefined);
    return c.json({ totalCount });
  } catch (e: any) {
    return c.json(safeError(e, "count-issues"), 500);
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
    return c.json(safeError(e, "trending-issues"), 500);
  }
});

async function callAi(
  provider: string,
  apiKey: string,
  model: string | undefined,
  prompt: string,
  maxTokens = 500
): Promise<{ summary?: string; error?: string }> {
  try {
    if (provider === "claude" || provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: String(model || "claude-haiku-4-5"),
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data: any = await res.json();
      if (!res.ok) return { error: data.error?.message ?? "Claude API error" };
      return { summary: data.content?.[0]?.text ?? "" };
    }
    if (provider === "openai" || provider === "openrouter") {
      const baseUrl =
        provider === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.openai.com/v1";
      const defaultModel = provider === "openrouter" ? "deepseek/deepseek-chat" : "gpt-4o-mini";
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
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data: any = await res.json();
      if (!res.ok) return { error: data.error?.message ?? "API error" };
      return { summary: data.choices?.[0]?.message?.content ?? "" };
    }
    return { error: "Unknown provider." };
  } catch (e: any) {
    return { error: e?.message || "AI request failed" };
  }
}

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
      `Reply in exactly this format (do not add any other text):\n` +
      `**Product:** [1-2 sentences on what this repo does]\n` +
      `**Languages:** [comma-separated list]\n` +
      `**Issue Summary:** [2-3 sentences on the problem and what solving it would require]`;
    const r = await callAi(String(provider), String(apiKey), model ? String(model) : undefined, prompt, 400);
    if (r.error) return c.json({ error: r.error }, 400);
    return c.json({ summary: r.summary || "" });
  } catch (e: any) {
    return c.json(safeError(e, "analyse"), 500);
  }
});

app.get("/api/count-repos", async (c) => {
  try {
    const language = c.req.query("language") ?? "";
    const topic = c.req.query("topic") ?? "";
    if (!language && !topic) return c.json({ error: "Provide a language or topic." }, 400);
    const totalCount = await github.countRepos(language, topic || undefined);
    return c.json({ totalCount });
  } catch (e: any) {
    return c.json(safeError(e, "count-repos"), 500);
  }
});

app.post("/api/trending-repos", async (c) => {
  try {
    const body = await c.req.json();
    const language = String(body.language ?? "");
    const topic = body.topic ? String(body.topic) : undefined;
    const tf = body.timeframe;
    const timeframe: "daily" | "weekly" | "monthly" =
      tf === "daily" || tf === "weekly" || tf === "monthly" ? tf : "weekly";
    const limits = { daily: 20, weekly: 30, monthly: 50 };
    if (!language && !topic) return c.json({ error: "Provide a language or topic." }, 400);
    const repos = await github.fetchTrendingRepos(language, topic, timeframe, limits[timeframe]);
    return c.json({ repos, timeframe, totalShown: repos.length });
  } catch (e: any) {
    return c.json(safeError(e, "trending-repos"), 500);
  }
});

app.post("/api/org-topics", async (c) => {
  try {
    const body = await c.req.json();
    const org = String(body.org ?? "").trim();
    const topic = body.topic ? String(body.topic).trim() : undefined;
    if (!org) return c.json({ error: "Provide an organization." }, 400);
    const [info, topics] = await Promise.all([
      github.fetchOrgInfo(org),
      github.fetchOrgTopTopics(org, topic, 10),
    ]);
    if (!info) return c.json({ error: `Organization not found: ${org}` }, 404);
    return c.json({ info, topics });
  } catch (e: any) {
    return c.json(safeError(e, "org-topics"), 500);
  }
});

app.post("/api/analyse-repo", async (c) => {
  try {
    const body = await c.req.json();
    const { apiKey, provider, model, repo } = body;
    if (!apiKey || !provider || !repo) {
      return c.json({ error: "Missing required fields." }, 400);
    }
    const [info, meta] = await Promise.all([
      github.fetchRepoInfo(String(repo)),
      github.fetchRepoMeta(String(repo)),
    ]);
    if (!info) return c.json({ error: `Repo not found: ${repo}` }, 404);
    const created = info.lastPushed ? "" : "";
    // Get full createdAt via a small additional call (already in fetchRepoInfo's source data — keep simple)
    let createdAtIso = "";
    try {
      const [owner, name] = String(repo).split("/");
      const { data } = await (github as any).octokit.repos.get({ owner, repo: name });
      createdAtIso = data.created_at ?? "";
    } catch {}
    const ageDays = createdAtIso
      ? Math.floor((Date.now() - new Date(createdAtIso).getTime()) / 86400000)
      : 0;
    const ageStr =
      ageDays >= 365
        ? `${(ageDays / 365).toFixed(1)} years (${ageDays} days)`
        : `${ageDays} days`;
    const prompt =
      `You are a developer assistant. Analyse this GitHub repository concisely.\n\n` +
      `Repo: ${repo}\n` +
      `Description: ${meta.description || "Not available"}\n` +
      `Languages used: ${meta.languages.length ? meta.languages.join(", ") : "Not available"}\n` +
      `Stars: ${info.stars}\n` +
      `Open issues: ${info.openIssues}\n` +
      `Age: ${ageStr}\n` +
      `Last pushed: ${info.lastPushed || "unknown"}\n\n` +
      `Reply in exactly this format (do not add any other text):\n` +
      `**Product:** [2-3 sentences on what this repo does and who uses it]\n` +
      `**Languages used:** [comma-separated list, primary first]\n` +
      `**Age:** [age + 1 sentence on maturity / activity status]\n` +
      `**Stars:** [number + 1 sentence on community size]\n` +
      `**Open issues:** [number + 1 sentence on what kinds of issues dominate]\n` +
      `**Summary:** [3-4 sentences: where this repo fits in the ecosystem, strengths, gaps, who should consider contributing]`;
    const r = await callAi(String(provider), String(apiKey), model ? String(model) : undefined, prompt, 700);
    if (r.error) return c.json({ error: r.error }, 400);
    return c.json({ summary: r.summary || "", info, languages: meta.languages, ageDays, createdAt: createdAtIso });
  } catch (e: any) {
    return c.json(safeError(e, "analyse-repo"), 500);
  }
});

app.post("/api/analyse-topic", async (c) => {
  try {
    const body = await c.req.json();
    const { apiKey, provider, model, org, topic } = body;
    if (!apiKey || !provider || !org || !topic) {
      return c.json({ error: "Missing required fields." }, 400);
    }
    const topics = await github.fetchOrgTopTopics(String(org), String(topic), 1);
    const match = topics.find((t) => t.name === String(topic).toLowerCase()) || topics[0];
    if (!match) return c.json({ error: `Topic '${topic}' not found in org '${org}'.` }, 404);
    const repoList = match.sampleRepos
      .map((r) => `- ${r.fullName} (${r.stars}★) — ${r.description || "no description"}`)
      .join("\n");
    const prompt =
      `You are a developer assistant. Analyse this GitHub topic within a specific organization.\n\n` +
      `Organization: ${org}\n` +
      `Topic: ${topic}\n` +
      `Repos in this org tagged with this topic (top by stars): ${match.repoCount} total\n` +
      `${repoList}\n` +
      `Primary languages across these repos: ${match.languages.join(", ") || "varied"}\n` +
      `Total open issues across these repos: ${match.totalOpenIssues}\n` +
      `Total stars across these repos: ${match.totalStars}\n\n` +
      `Reply in exactly this format (do not add any other text):\n` +
      `**Topic:** [1-2 sentences explaining what this topic represents]\n` +
      `**What it covers:** [2-3 sentences on what the org's work in this area focuses on]\n` +
      `**Repos in this org:** [name the top 3-5 repos and a phrase each on what they do]\n` +
      `**Primary languages:** [comma-separated, primary first]\n` +
      `**Total open issues:** [number + 1 sentence on what kinds of issues typically appear here]\n` +
      `**Summary:** [3-4 sentences: where this topic sits in the org's portfolio, momentum, opportunities for contributors]`;
    const r = await callAi(String(provider), String(apiKey), model ? String(model) : undefined, prompt, 800);
    if (r.error) return c.json({ error: r.error }, 400);
    return c.json({ summary: r.summary || "", topic: match });
  } catch (e: any) {
    return c.json(safeError(e, "analyse-topic"), 500);
  }
});

app.get("/", (c) => c.html(PAGE_HTML));

const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GapScout — Find GitHub Gaps</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ---------- Tokens ---------- */
:root {
  --bg:        oklch(0.16 0.012 250);
  --bg-2:      oklch(0.185 0.013 252);
  --surface:   oklch(0.215 0.014 252);
  --surface-2: oklch(0.245 0.014 252);
  --border:    oklch(0.30 0.012 252);
  --border-2:  oklch(0.36 0.014 252);
  --text:      oklch(0.965 0.005 250);
  --text-2:    oklch(0.78 0.008 250);
  --muted:     oklch(0.60 0.012 250);
  --muted-2:   oklch(0.46 0.012 250);

  --accent:        oklch(0.80 0.155 70);
  --accent-soft:   oklch(0.80 0.155 70 / 0.14);
  --accent-deep:   oklch(0.70 0.16 65);
  --info:          oklch(0.78 0.13 235);
  --info-soft:     oklch(0.78 0.13 235 / 0.14);
  --ok:            oklch(0.78 0.14 155);
  --warn:          oklch(0.80 0.15 80);
  --danger:        oklch(0.72 0.18 25);

  --font-ui: "Geist", "Söhne", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --r-xl: 22px;

  --shadow-card: 0 1px 0 0 oklch(1 0 0 / 0.04) inset, 0 0 0 1px var(--border), 0 20px 40px -24px oklch(0 0 0 / 0.55);
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background:
    radial-gradient(1100px 600px at 10% -10%, oklch(0.27 0.04 255 / 0.45), transparent 60%),
    radial-gradient(900px 500px at 110% 0%, oklch(0.30 0.06 60 / 0.18), transparent 65%),
    var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.005em;
}
.mono { font-family: var(--font-mono); letter-spacing: 0; }
.small { font-size: 12px; }
.muted { color: var(--muted); }
.opt { color: var(--muted-2); font-weight: 400; font-size: 11px; margin-left: 4px; text-transform: uppercase; letter-spacing: 0.06em; }

.app { min-height: 100%; display: flex; flex-direction: column; }
.header {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 48px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--bg) 84%, transparent);
  backdrop-filter: blur(14px);
}
.header-right { display: flex; align-items: center; gap: 14px; }
.header-meta { display: flex; align-items: center; gap: 8px; color: var(--muted); }

.logo { display: flex; align-items: center; gap: 12px; color: var(--accent); }
.logo-text { color: var(--text); }
.logo-title { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
.logo-sub { font-size: 13px; color: var(--muted); letter-spacing: 0.02em; margin-top: -1px; }

.settings-btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 12px 8px 10px;
  border: 1px solid var(--border-2);
  background: var(--surface);
  color: var(--text);
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.settings-btn:hover { border-color: var(--accent); color: var(--accent); background: color-mix(in oklab, var(--surface) 92%, var(--accent) 8%); }
.settings-btn svg { opacity: 0.85; }
.settings-provider {
  font-size: 11px; color: var(--muted); padding: 2px 6px;
  border: 1px solid var(--border); border-radius: 6px; margin-left: 2px;
  background: var(--bg-2);
}

.main {
  flex: 1; width: 100%; max-width: 1900px; margin: 0 auto;
  padding: 28px 48px 80px; display: flex; flex-direction: column; gap: 24px;
}

/* Tab bar */
.tabs-bar {
  display: inline-flex; align-self: flex-start; gap: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 6px;
}
.tab-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 18px; border-radius: 8px;
  background: transparent; border: 1px solid transparent;
  color: var(--text-2); font-family: inherit; font-size: 14.5px; font-weight: 500;
  cursor: pointer; transition: all 0.16s ease;
}
.tab-pill:hover:not(.active) { color: var(--text); background: var(--bg-2); }
.tab-pill.active {
  background: var(--bg);
  border-color: var(--border-2);
  color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.tab-pill .tp-glyph { font-size: 14px; opacity: 0.85; }

/* Repo card */
.repo-card {
  display: grid; grid-template-columns: 56px 1fr; gap: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg);
  transition: border-color 0.18s, transform 0.18s;
  overflow: hidden;
}
.repo-card:hover { border-color: var(--border-2); }
.repo-card .rc-rank { font-family: var(--font-mono); color: var(--muted-2); font-size: 14px; padding: 20px 0 0 20px; align-self: start; }
.repo-card .rc-body { padding: 18px 22px 16px 4px; min-width: 0; }
.rc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13.5px; color: var(--text-2); }
.rc-name { color: var(--text); font-size: 18px; font-weight: 600; font-family: var(--font-mono); letter-spacing: -0.005em; text-decoration: none; }
.rc-name:hover { color: var(--accent); }
.rc-stars { display: inline-flex; align-items: center; gap: 4px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-family: var(--font-mono); font-size: 12.5px; color: var(--text); }
.rc-stars .ic { color: var(--accent); font-size: 11px; }
.rc-desc { margin-top: 10px; color: var(--text-2); font-size: 15px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rc-topics { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.rc-topic-chip { font-family: var(--font-mono); font-size: 11.5px; color: var(--info); background: var(--info-soft); border: 1px solid oklch(0.78 0.13 235 / 0.3); padding: 2px 9px; border-radius: 999px; }
.rc-footer { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.rc-issues { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 13px; color: var(--muted); }

/* Topic card */
.topic-card {
  display: grid; grid-template-columns: 56px 1fr; gap: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg);
  transition: border-color 0.18s;
  overflow: hidden;
}
.topic-card:hover { border-color: var(--border-2); }
.topic-card .tc-rank { font-family: var(--font-mono); color: var(--muted-2); font-size: 14px; padding: 22px 0 0 20px; }
.topic-card .tc-body { padding: 20px 22px 18px 4px; min-width: 0; }
.tc-name { font-family: var(--font-mono); font-size: 22px; font-weight: 600; color: var(--accent); letter-spacing: -0.01em; }
.tc-stats { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 14px; color: var(--text-2); flex-wrap: wrap; }
.tc-stat { display: inline-flex; align-items: center; gap: 6px; }
.tc-stat strong { color: var(--text); font-weight: 600; }
.tc-stat .ic { color: var(--accent); }
.tc-repos { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.tc-repo-link { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-2); background: var(--bg-2); border: 1px solid var(--border); padding: 4px 10px; border-radius: 6px; text-decoration: none; transition: all 0.15s; }
.tc-repo-link:hover { color: var(--accent); border-color: var(--accent); }
.tc-footer { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.tc-langs { display: flex; gap: 6px; flex-wrap: wrap; }

/* Org info banner */
.org-banner {
  display: flex; align-items: center; gap: 18px;
  background: linear-gradient(180deg, var(--surface) 0%, var(--bg-2) 100%);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  padding: 18px 22px;
}
.org-avatar { width: 56px; height: 56px; border-radius: 14px; border: 1px solid var(--border-2); background: var(--bg-2); object-fit: cover; }
.org-meta { flex: 1; min-width: 0; }
.org-name { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
.org-desc { color: var(--text-2); margin-top: 4px; font-size: 15px; line-height: 1.5; }
.org-stats { display: flex; gap: 16px; margin-top: 8px; font-family: var(--font-mono); font-size: 12.5px; color: var(--muted); }
.org-stats a { color: var(--accent); text-decoration: none; }
.org-stats a:hover { text-decoration: underline; }

/* Search panel */
.search-panel {
  background: linear-gradient(180deg, var(--surface) 0%, var(--bg-2) 100%);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  padding: 22px;
  box-shadow: var(--shadow-card);
  position: relative;
  overflow: hidden;
}
.search-panel::before {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(600px 200px at 30% -10%, oklch(0.80 0.155 70 / 0.10), transparent 60%);
  pointer-events: none;
}
.search-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 12px;
  position: relative;
}
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field label {
  font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--muted); font-weight: 500;
}
.input-wrap {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg);
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  padding: 0 14px;
  height: 52px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.input-wrap:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 4px oklch(0.80 0.155 70 / 0.12);
}
.input-icon {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 15px;
  width: 16px; text-align: center;
}
.input-wrap input {
  flex: 1; min-width: 0;
  background: transparent; border: 0; outline: 0;
  color: var(--text); font-family: inherit; font-size: 16px;
}
.input-wrap input::placeholder { color: var(--muted-2); }

.search-btn { height: 52px; padding: 0 24px; font-size: 15px; }
.search-hints {
  display: flex; align-items: center; gap: 10px; margin-top: 18px;
  flex-wrap: wrap;
}
.hint-label { font-size: 13px; color: var(--muted-2); text-transform: uppercase; letter-spacing: 0.1em; margin-right: 4px; }
.chip-suggest {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 14px;
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.chip-suggest:hover { border-color: var(--accent); color: var(--accent); }
.chip-sep { color: var(--muted-2); }
.chip-lang { color: var(--text); }
.chip-topic { color: var(--text-2); }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: inherit; font-size: 13.5px; font-weight: 500;
  border-radius: 10px; cursor: pointer;
  transition: all 0.15s;
  border: 1px solid transparent;
  padding: 0 14px; height: 36px;
  white-space: nowrap;
}
.btn-primary {
  background: var(--accent);
  color: oklch(0.18 0.02 60);
  border-color: var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: oklch(0.85 0.16 70);
  box-shadow: 0 8px 24px -10px oklch(0.80 0.155 70 / 0.55);
  transform: translateY(-1px);
}
.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-ghost {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border-2);
}
.btn-ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }

.btn kbd {
  background: oklch(0.30 0.02 60); color: oklch(0.16 0.02 60);
  padding: 1px 6px; border-radius: 4px; font-size: 11px; font-family: var(--font-mono);
  margin-left: 2px;
}
.link-btn {
  background: transparent; border: 0; color: var(--muted);
  font-family: inherit; font-size: 12.5px; cursor: pointer; padding: 4px 6px;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}
.link-btn:hover { color: var(--text); background: var(--surface); }

.icon-btn {
  background: transparent; border: 0; color: var(--muted);
  width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.icon-btn:hover { background: var(--surface); color: var(--text); }

.ghost-mini {
  background: transparent; border: 1px solid var(--border-2); color: var(--muted);
  font-family: inherit; font-size: 11px;
  padding: 2px 8px; border-radius: 6px; cursor: pointer;
}
.ghost-mini:hover { color: var(--text); border-color: var(--accent); }

/* Spinners */
.spinner, .spinner-sm {
  display: inline-block;
  border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.spinner { width: 14px; height: 14px; }
.spinner-sm { width: 11px; height: 11px; border-width: 1.5px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Stats strip */
.stats-strip {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  padding: 8px 4px 0;
}
.stat-main { display: flex; flex-direction: column; gap: 4px; }
.stat-num {
  font-size: 56px; font-weight: 600; letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(180deg, var(--text) 0%, oklch(0.78 0.04 70) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  line-height: 1.05;
}
.stat-label { color: var(--text-2); font-size: 17px; }
.stat-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.stat-pip {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-2);
  background: var(--surface); border: 1px solid var(--border);
  padding: 4px 10px; border-radius: 999px;
}
.stat-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted-2); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px oklch(0.78 0.14 155 / 0.18); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px oklch(0.80 0.15 80 / 0.18); }
.dot.live { background: var(--ok); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 oklch(0.78 0.14 155 / 0.6); }
  50%      { opacity: 0.8; box-shadow: 0 0 0 6px oklch(0.78 0.14 155 / 0); }
}

/* Timeframe bar */
.timeframe-bar {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 6px;
}
.tf {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 0 12px;
  padding: 10px 14px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.18s;
}
.tf:hover { background: var(--bg-2); color: var(--text); }
.tf.active {
  background: var(--bg);
  border-color: var(--border-2);
  color: var(--text);
  box-shadow: 0 0 0 1px var(--accent) inset, 0 8px 24px -16px oklch(0.80 0.155 70 / 0.4);
}
.tf-label { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; grid-column: 1; grid-row: 1; }
.tf-sub { font-size: 13px; color: var(--muted); grid-column: 1; grid-row: 2; font-family: var(--font-mono); }
.tf-n {
  grid-column: 2; grid-row: 1 / span 2;
  font-family: var(--font-mono);
  font-size: 12.5px;
  padding: 4px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
}
.tf.active .tf-n { color: var(--accent); border-color: oklch(0.80 0.155 70 / 0.4); background: oklch(0.80 0.155 70 / 0.10); }

/* Results */
.results-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 4px 0;
  margin-top: 20px;
}
.results-title { font-size: 15px; color: var(--text-2); }
.rh-em { color: var(--text); font-weight: 600; }
.results-actions { display: flex; gap: 8px; }
.results-actions .link-btn {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border-2);
  padding: 7px 14px;
  border-radius: 8px;
  transition: all 0.15s;
}
.results-actions .link-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in oklab, var(--surface) 92%, var(--accent) 8%);
}
.results-actions .link-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.issues { display: flex; flex-direction: column; gap: 10px; }

.issue {
  display: grid;
  grid-template-columns: 56px 1fr;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  transition: border-color 0.18s, transform 0.18s;
  overflow: hidden;
}
.issue:hover { border-color: var(--border-2); }
.issue.expanded { border-color: oklch(0.80 0.155 70 / 0.4); box-shadow: 0 0 0 1px oklch(0.80 0.155 70 / 0.18); }
.issue.skel { height: 96px; background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%); background-size: 200% 100%; animation: shimmer 1.4s infinite; border-color: transparent; }
@keyframes shimmer { to { background-position: -200% 0; } }

.issue-rank {
  font-family: var(--font-mono);
  color: var(--muted-2);
  font-size: 14px;
  padding: 20px 0 0 20px;
  align-self: start;
}
.issue-body { padding: 18px 22px 16px 4px; min-width: 0; }
.issue-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13.5px; color: var(--text-2); }
.repo { color: var(--text); font-weight: 500; }
.dot-sep { color: var(--muted-2); }
.lang-swatch { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.badge {
  font-family: var(--font-mono); font-size: 10.5px;
  padding: 1px 7px; border-radius: 4px;
  text-transform: lowercase;
}
.badge-stale { color: var(--warn); background: oklch(0.80 0.15 80 / 0.12); border: 1px solid oklch(0.80 0.15 80 / 0.3); }

.issue-title {
  display: block; margin-top: 8px;
  color: var(--text); font-size: 18px; font-weight: 500;
  text-decoration: none;
  letter-spacing: -0.01em;
  line-height: 1.4;
  transition: color 0.15s;
}
.issue-title:hover { color: var(--accent); }

.issue-footer {
  display: flex; align-items: center; gap: 12px;
  margin-top: 14px;
}
.reactions {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 999px; padding: 4px 12px;
  font-family: var(--font-mono); font-size: 13.5px;
}
.r-up { color: var(--accent); font-size: 10px; }
.r-n { color: var(--text); }
.comments-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--font-mono); font-size: 13px; color: var(--muted);
}
.comments-pill .ic { filter: grayscale(1) brightness(1.4); opacity: 0.5; font-size: 12px; }

.labels { display: flex; gap: 6px; flex-wrap: wrap; }
.label {
  font-family: var(--font-mono); font-size: 12px;
  padding: 3px 9px; border-radius: 4px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.label-bug { color: oklch(0.78 0.16 25); border-color: oklch(0.78 0.16 25 / 0.3); background: oklch(0.78 0.16 25 / 0.10); }
.label-enhancement { color: oklch(0.78 0.13 200); border-color: oklch(0.78 0.13 200 / 0.3); background: oklch(0.78 0.13 200 / 0.10); }
.label-help-wanted { color: oklch(0.82 0.16 145); border-color: oklch(0.82 0.16 145 / 0.3); background: oklch(0.82 0.16 145 / 0.10); }
.label-good-first-issue { color: oklch(0.82 0.16 145); border-color: oklch(0.82 0.16 145 / 0.3); background: oklch(0.82 0.16 145 / 0.10); }
.label-regression { color: oklch(0.78 0.16 25); border-color: oklch(0.78 0.16 25 / 0.3); background: oklch(0.78 0.16 25 / 0.10); }
.label-performance { color: oklch(0.85 0.14 85); border-color: oklch(0.85 0.14 85 / 0.3); background: oklch(0.85 0.14 85 / 0.10); }

.spacer { flex: 1; }
.analyse-btn {
  background: oklch(0.80 0.155 70 / 0.08);
  border-color: oklch(0.80 0.155 70 / 0.35);
  color: var(--accent);
  height: 34px; padding: 0 14px; font-size: 14px; font-weight: 500;
}
.analyse-btn:hover { background: oklch(0.80 0.155 70 / 0.15); border-color: var(--accent); }
.analyse-btn.done { background: transparent; border-color: var(--border-2); color: var(--text-2); }
.analyse-btn.done:hover { color: var(--text); }
.analyse-btn .sparkle { color: var(--accent); }
.analyse-btn .caret { font-size: 10px; opacity: 0.7; }

/* Analysis expansion */
.analysis {
  grid-column: 1 / -1;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
  padding: 18px 24px 16px 56px;
  animation: slideDown 0.25s ease;
}
@keyframes slideDown {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.analysis-grid { display: flex; flex-direction: column; gap: 12px; }
.a-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 16px;
  align-items: baseline;
}
.a-key {
  font-family: var(--font-mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted);
}
.a-val { color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
.analysis-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
}

/* Empty state */
.empty {
  display: flex; flex-direction: column; align-items: center;
  text-align: center;
  padding: 60px 20px 40px;
}
.empty-art {
  position: relative;
  width: 180px; height: 130px;
  margin-bottom: 28px;
}
.ea-grid {
  position: absolute; inset: 0;
  display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px;
  opacity: 0.4;
}
.ea-cell {
  background: var(--surface-2);
  border-radius: 2px;
  animation: ea-blink 4s infinite;
}
@keyframes ea-blink {
  0%, 92%, 100% { background: var(--surface-2); }
  93%, 96% { background: var(--accent); }
}
.ea-target {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 6px var(--bg), 0 0 0 7px oklch(0.80 0.155 70 / 0.6), 0 0 40px 6px oklch(0.80 0.155 70 / 0.4);
}
.empty-title { font-size: 26px; font-weight: 500; letter-spacing: -0.02em; max-width: 620px; line-height: 1.35; }
.empty-sub { color: var(--muted); font-size: 16px; margin-top: 14px; max-width: 560px; line-height: 1.6; }

/* Footer */
.footer {
  margin-top: 24px; padding-top: 18px;
  border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.footer-links { display: flex; gap: 16px; }
.footer-links a {
  color: var(--muted); font-family: var(--font-mono); font-size: 12px;
  text-decoration: none;
}
.footer-links a:hover { color: var(--accent); }

/* Modal */
.modal-scrim {
  position: fixed; inset: 0; z-index: 100;
  background: oklch(0 0 0 / 0.55);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  animation: fadeIn 0.18s ease;
  padding: 20px;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.modal {
  width: 100%; max-width: 460px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--r-xl);
  box-shadow: 0 30px 80px -20px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(1 0 0 / 0.04) inset;
  animation: pop 0.2s cubic-bezier(.2,.9,.3,1.2);
  overflow: hidden;
}
.modal.modal-wide { max-width: 800px; }
.modal.modal-wide .modal-body { padding: 24px; }
.modal.modal-wide .modal-head { padding: 22px 24px 16px; }
.modal.modal-wide .modal-title { font-size: 19px; }
.modal .a-row { grid-template-columns: 150px 1fr; gap: 22px; }
.modal .a-key { font-size: 13px; }
.modal .a-val { font-size: 17px; line-height: 1.7; color: var(--text); }
.modal .modal-body .analysis-grid { gap: 22px; }
.modal-title-issue { font-size: 15px; color: var(--text-2); margin-top: 6px; font-weight: 400; line-height: 1.5; }
.modal-foot-link { color: var(--accent); font-family: inherit; font-size: 14px; text-decoration: none; font-weight: 500; }
.modal-foot-link:hover { text-decoration: underline; }
@keyframes pop {
  from { opacity: 0; transform: translateY(8px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.modal-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 18px 18px 14px;
  gap: 12px;
  border-bottom: 1px solid var(--border);
}
.modal-title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.modal-sub { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 340px; line-height: 1.5; }
.modal-body { padding: 18px; display: flex; flex-direction: column; gap: 18px; }
.modal-foot {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
}
.foot-status { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.foot-actions { display: flex; gap: 8px; }

.form-row { display: flex; flex-direction: column; gap: 8px; }
.form-row > label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--muted); font-weight: 500;
}
.form-help { font-size: 11.5px; color: var(--muted-2); }
.form-help .mono { color: var(--muted); }

.provider-grid { display: flex; flex-direction: column; gap: 6px; }
.provider-card {
  display: grid;
  grid-template-columns: 36px 1fr 20px;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: all 0.15s;
}
.provider-card:hover { border-color: var(--border-2); }
.provider-card.selected {
  border-color: var(--accent);
  background: color-mix(in oklab, var(--bg) 88%, var(--accent) 12%);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.pc-glyph {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 16px; color: var(--text-2);
}
.provider-card.selected .pc-glyph { color: var(--accent); border-color: oklch(0.80 0.155 70 / 0.4); }
.pc-name { font-size: 13.5px; font-weight: 500; color: var(--text); }
.pc-model { font-size: 11px; color: var(--muted); margin-top: 1px; }
.pc-radio {
  width: 16px; height: 16px; border-radius: 50%;
  border: 1.5px solid var(--border-2);
  display: flex; align-items: center; justify-content: center;
}
.provider-card.selected .pc-radio { border-color: var(--accent); }
.pc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }

.key-wrap input { font-family: var(--font-mono); font-size: 12.5px; letter-spacing: 0.04em; }

.error-banner {
  background: oklch(0.30 0.12 25 / 0.20); border: 1px solid oklch(0.72 0.18 25 / 0.45);
  color: oklch(0.92 0.06 25); padding: 10px 14px; border-radius: 10px;
  font-size: 13px;
}

@media (max-width: 720px) {
  .search-row { grid-template-columns: 1fr; }
  .stats-strip { flex-direction: column; align-items: flex-start; gap: 6px; }
  .stat-side { align-items: flex-start; }
  .timeframe-bar { grid-template-columns: 1fr; }
  .header { padding: 12px 16px; }
  .main { padding: 24px 16px 60px; }
  .a-row { grid-template-columns: 1fr; gap: 4px; }
  .results-actions { display: none; }
}
</style>
</head>
<body>
<div id="root">
  <div class="app">
    <header class="header">
      <div class="logo">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="25" height="25" rx="7" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
          <circle cx="10.5" cy="14" r="3.2" stroke="currentColor" stroke-width="1.6"/>
          <path d="M14 14H22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="2 2.5"/>
          <circle cx="22" cy="14" r="1.2" fill="var(--accent)"/>
        </svg>
        <div class="logo-text">
          <div class="logo-title">GapScout</div>
          <div class="logo-sub">Find GitHub Gaps</div>
        </div>
      </div>
      <div class="header-right">
        <div class="header-meta">
          <span class="dot ok"></span>
          <span class="mono small">api · /api/trending-issues</span>
        </div>
        <button class="settings-btn" id="open-settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" stroke="currentColor" stroke-width="1.6"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.07-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.07 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" stroke-width="1.6"/>
          </svg>
          AI Settings
          <span class="settings-provider mono" id="provider-pill">openrouter</span>
        </button>
      </div>
    </header>

    <main class="main">
      <div class="tabs-bar" role="tablist">
        <button class="tab-pill active" role="tab" data-tab="issues"><span class="tp-glyph">⚑</span> Issues</button>
        <button class="tab-pill" role="tab" data-tab="repos"><span class="tp-glyph">◇</span> Repositories</button>
        <button class="tab-pill" role="tab" data-tab="org"><span class="tp-glyph">◉</span> Organization</button>
      </div>

      <!-- ISSUES + REPOS share the same form shape (language + topic) -->
      <form class="search-panel" id="search-form-lt" autocomplete="off">
        <div class="search-row">
          <div class="field">
            <label for="lang-input">Language</label>
            <div class="input-wrap">
              <span class="input-icon">&lt;/&gt;</span>
              <input id="lang-input" placeholder="python, typescript, rust…" spellcheck="false" autocomplete="off"/>
            </div>
          </div>
          <div class="field">
            <label for="topic-input">Topic <span class="opt">optional</span></label>
            <div class="input-wrap">
              <span class="input-icon">#</span>
              <input id="topic-input" placeholder="agents, scraping, inference…" spellcheck="false" autocomplete="off"/>
            </div>
          </div>
          <button class="btn btn-primary search-btn" type="submit" id="search-btn">
            <span id="search-btn-label">Search</span>
            <kbd>↵</kbd>
          </button>
        </div>
        <div class="search-hints">
          <span class="hint-label">Try</span>
          <button type="button" class="chip-suggest" data-l="python" data-t="agents"><span class="chip-lang">python</span><span class="chip-sep">·</span><span class="chip-topic">agents</span></button>
          <button type="button" class="chip-suggest" data-l="rust" data-t=""><span class="chip-lang">rust</span></button>
          <button type="button" class="chip-suggest" data-l="typescript" data-t="scraping"><span class="chip-lang">typescript</span><span class="chip-sep">·</span><span class="chip-topic">scraping</span></button>
          <button type="button" class="chip-suggest" data-l="go" data-t="observability"><span class="chip-lang">go</span><span class="chip-sep">·</span><span class="chip-topic">observability</span></button>
        </div>
      </form>

      <!-- ORG form (hidden unless active tab is 'org') -->
      <form class="search-panel" id="search-form-org" autocomplete="off" style="display:none">
        <div class="search-row">
          <div class="field">
            <label for="org-input">Organization</label>
            <div class="input-wrap">
              <span class="input-icon">@</span>
              <input id="org-input" placeholder="uipath, microsoft, vercel, apache…" spellcheck="false" autocomplete="off"/>
            </div>
          </div>
          <div class="field">
            <label for="org-topic-input">Topic <span class="opt">optional filter</span></label>
            <div class="input-wrap">
              <span class="input-icon">#</span>
              <input id="org-topic-input" placeholder="agents, mlops, automation…" spellcheck="false" autocomplete="off"/>
            </div>
          </div>
          <button class="btn btn-primary search-btn" type="submit" id="search-btn-org">
            <span id="search-btn-org-label">Search</span>
            <kbd>↵</kbd>
          </button>
        </div>
        <div class="search-hints">
          <span class="hint-label">Try</span>
          <button type="button" class="chip-suggest org-chip" data-o="microsoft" data-t=""><span class="chip-lang">microsoft</span></button>
          <button type="button" class="chip-suggest org-chip" data-o="uipath" data-t="agents"><span class="chip-lang">uipath</span><span class="chip-sep">·</span><span class="chip-topic">agents</span></button>
          <button type="button" class="chip-suggest org-chip" data-o="vercel" data-t=""><span class="chip-lang">vercel</span></button>
          <button type="button" class="chip-suggest org-chip" data-o="apache" data-t=""><span class="chip-lang">apache</span></button>
        </div>
      </form>

      <div id="error-slot"></div>
      <div id="results-slot"></div>

      <footer class="footer">
        <div class="mono small muted">gapscout · v0.4.2 · local · github + your llm</div>
        <div class="footer-links">
          <a href="#" onclick="return false">docs</a>
          <a href="#" onclick="return false">mcp tools</a>
          <a href="#" onclick="return false">changelog</a>
        </div>
      </footer>
    </main>
  </div>
</div>

<div id="modal-slot"></div>
<div id="analysis-modal-slot"></div>

<script>
(function(){
  'use strict';

  var PROVIDERS = [
    { id: 'anthropic',  label: 'Claude (Anthropic)',              short: 'claude',     defaultModel: 'claude-haiku-4-5',         placeholder: 'sk-ant-…', glyph: '✺' },
    { id: 'openai',     label: 'OpenAI',                          short: 'openai',     defaultModel: 'gpt-4o-mini',              placeholder: 'sk-…',     glyph: '◎' },
    { id: 'openrouter', label: 'OpenRouter (DeepSeek / any model)', short: 'openrouter', defaultModel: 'deepseek/deepseek-chat',   placeholder: 'sk-or-…',  glyph: '⌘' }
  ];

  var TAB_LABELS = {
    issues: { empty: 'Find the next issue to fix —\nbefore everyone else does.', sub: 'Pick a language and (optionally) a topic. GapScout surfaces the open issues with real demand across the GitHub ecosystem.' },
    repos:  { empty: 'Find the repositories shaping a space.',                   sub: 'Pick a language and (optionally) a topic. GapScout lists the most active repositories pushed in that window, sorted by stars.' },
    org:    { empty: 'Map an organization’s footprint.',                    sub: 'Type an org name (e.g. uipath, microsoft). GapScout aggregates the top topics across their public repositories.' }
  };

  var LANG_COLOR = {
    Python: '#3776AB', TypeScript: '#3178C6', JavaScript: '#F1E05A',
    Go: '#00ADD8', Rust: '#DEA584', 'C++': '#F34B7D', C: '#555555',
    Java: '#B07219', Kotlin: '#A97BFF', Swift: '#FA7343',
    Ruby: '#701516', PHP: '#4F5D95', Shell: '#89E051', Lua: '#000080',
    HTML: '#E34C26', CSS: '#563D7C', Vue: '#41B883'
  };
  function normalizeLang(l) {
    if (!l) return '';
    var x = String(l).trim();
    var lower = x.toLowerCase();
    var map = { python:'Python', typescript:'TypeScript', javascript:'JavaScript', go:'Go', rust:'Rust', 'c++':'C++', cpp:'C++', c:'C', java:'Java', kotlin:'Kotlin', swift:'Swift', ruby:'Ruby', php:'PHP', shell:'Shell', bash:'Shell' };
    return map[lower] || x.charAt(0).toUpperCase() + x.slice(1);
  }

  var state = {
    activeTab: 'issues',
    issues: { searched: null, searching: false, timeframe: 'weekly', dataByTf: {}, loadingTf: false },
    repos:  { searched: null, searching: false, timeframe: 'weekly', dataByTf: {}, loadingTf: false },
    org:    { info: null, topics: [], searching: false, query: null },
    analyses: {},           // keyed by 'issue:<repo>#<num>', 'repo:<full>', 'topic:<org>::<name>'
    analysing: {},
    analysisOpenFor: null,
    settings: loadSettings(),
    settingsOpen: false,
    modalDraft: null,
    error: ''
  };
  function cur() { return state[state.activeTab]; }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('gapscout-ai-settings') || '{}');
      return {
        provider: s.provider || 'openrouter',
        apiKey: s.apiKey || '',
        model: s.model || 'deepseek/deepseek-chat'
      };
    } catch (e) {
      return { provider: 'openrouter', apiKey: '', model: 'deepseek/deepseek-chat' };
    }
  }
  function saveSettings(s) {
    state.settings = { provider: s.provider, apiKey: s.apiKey, model: s.model };
    localStorage.setItem('gapscout-ai-settings', JSON.stringify(state.settings));
    updateProviderPill();
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function issueKey(it) { return (it.repo || '') + '#' + (it.number || ''); }

  function tfCount(tf) { return tf === 'daily' ? 20 : tf === 'weekly' ? 30 : 50; }
  function tfDays(tf)  { return tf === 'daily' ?  1 : tf === 'weekly' ?  7 : 30; }
  function tfWindow(tf){ return tf === 'daily' ? '24 hours' : tf === 'weekly' ? '7 days' : '30 days'; }

  function formatAge(d, h) {
    if (d == null) return '';
    if (d === 0 && h === 0) return 'just now';
    if (d === 0) return h + 'h ago';
    if (d === 1) return '1d ago';
    return d + 'd ago';
  }

  function safeLabelClass(l) {
    return 'label label-' + String(l || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  // ---------- API ----------
  function apiCount(lang, topic) {
    var p = new URLSearchParams();
    if (lang) p.set('language', lang);
    if (topic) p.set('topic', topic);
    return fetch('/api/count-issues?' + p.toString()).then(function(r){ return r.json(); });
  }
  function apiTrending(lang, topic, tf) {
    return fetch('/api/trending-issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang, topic: topic || undefined, timeframe: tf })
    }).then(function(r){ return r.json(); });
  }
  function apiAnalyse(issue) {
    var s = state.settings;
    var providerForApi = s.provider === 'anthropic' ? 'claude' : s.provider;
    return fetch('/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: s.apiKey,
        provider: providerForApi,
        model: s.model || providerInfo(s.provider).defaultModel,
        repo: issue.repo,
        issueTitle: issue.title,
        issueBody: issue.body || '',
        labels: issue.labels || []
      })
    }).then(function(r){ return r.json(); });
  }
  function apiCountRepos(lang, topic) {
    var p = new URLSearchParams();
    if (lang) p.set('language', lang);
    if (topic) p.set('topic', topic);
    return fetch('/api/count-repos?' + p.toString()).then(function(r){ return r.json(); });
  }
  function apiTrendingRepos(lang, topic, tf) {
    return fetch('/api/trending-repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang, topic: topic || undefined, timeframe: tf })
    }).then(function(r){ return r.json(); });
  }
  function apiOrgTopics(org, topic) {
    return fetch('/api/org-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org: org, topic: topic || undefined })
    }).then(function(r){ return r.json(); });
  }
  function apiAnalyseRepo(fullName) {
    var s = state.settings;
    var providerForApi = s.provider === 'anthropic' ? 'claude' : s.provider;
    return fetch('/api/analyse-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: s.apiKey,
        provider: providerForApi,
        model: s.model || providerInfo(s.provider).defaultModel,
        repo: fullName
      })
    }).then(function(r){ return r.json(); });
  }
  function apiAnalyseTopic(org, topic) {
    var s = state.settings;
    var providerForApi = s.provider === 'anthropic' ? 'claude' : s.provider;
    return fetch('/api/analyse-topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: s.apiKey,
        provider: providerForApi,
        model: s.model || providerInfo(s.provider).defaultModel,
        org: org,
        topic: topic
      })
    }).then(function(r){ return r.json(); });
  }

  function providerInfo(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return PROVIDERS[2];
  }

  function pickSection(text, label) {
    var re = new RegExp('\\*\\*' + label + ':?\\*\\*\\s*([\\s\\S]+?)(?=\\n\\s*\\*\\*|$)', 'i');
    var m = String(text || '').match(re);
    return m ? m[1].trim() : '';
  }
  function parseAnalysis(text) {
    return {
      product: pickSection(text, 'Product'),
      languages: pickSection(text, 'Languages') || pickSection(text, 'Languages used'),
      summary: pickSection(text, 'Issue Summary') || pickSection(text, 'Summary')
    };
  }
  function parseRepoAnalysis(text) {
    return [
      { key: 'Product',       val: pickSection(text, 'Product') },
      { key: 'Languages used',val: pickSection(text, 'Languages used') || pickSection(text, 'Languages') },
      { key: 'Age',           val: pickSection(text, 'Age') },
      { key: 'Stars',         val: pickSection(text, 'Stars') },
      { key: 'Open issues',   val: pickSection(text, 'Open issues') },
      { key: 'Summary',       val: pickSection(text, 'Summary') }
    ];
  }
  function parseTopicAnalysis(text) {
    return [
      { key: 'Topic',             val: pickSection(text, 'Topic') },
      { key: 'What it covers',    val: pickSection(text, 'What it covers') },
      { key: 'Repos in this org', val: pickSection(text, 'Repos in this org') },
      { key: 'Primary languages', val: pickSection(text, 'Primary languages') || pickSection(text, 'Languages') },
      { key: 'Total open issues', val: pickSection(text, 'Total open issues') || pickSection(text, 'Open issues') },
      { key: 'Summary',           val: pickSection(text, 'Summary') }
    ];
  }

  // ---------- Renderers ----------
  function setError(msg) {
    state.error = msg || '';
    var slot = $('error-slot');
    slot.innerHTML = state.error
      ? '<div class="error-banner">' + esc(state.error) + '</div>'
      : '';
  }

  function updateProviderPill() {
    var pill = $('provider-pill');
    if (pill) pill.textContent = providerInfo(state.settings.provider).short;
  }

  function updateSearchButton() {
    // The Issues+Repos tabs share btn ids; Org has its own.
    if (state.activeTab === 'org') {
      var btnO = $('search-btn-org');
      var lblO = $('search-btn-org-label');
      var orgVal = $('org-input').value.trim();
      btnO.disabled = state.org.searching || !orgVal;
      if (state.org.searching) {
        lblO.innerHTML = '<span class="spinner"></span> Searching';
        var kbdO = btnO.querySelector('kbd'); if (kbdO) kbdO.style.display = 'none';
      } else {
        lblO.textContent = 'Search';
        var kbdO2 = btnO.querySelector('kbd'); if (kbdO2) kbdO2.style.display = '';
      }
      return;
    }
    var btn = $('search-btn');
    var label = $('search-btn-label');
    var langVal = $('lang-input').value.trim();
    var topicVal = $('topic-input').value.trim();
    var c = cur();
    var disabled = c.searching || (!langVal && !topicVal);
    btn.disabled = disabled;
    if (c.searching) {
      label.innerHTML = '<span class="spinner"></span> Searching';
      var kbd = btn.querySelector('kbd'); if (kbd) kbd.style.display = 'none';
    } else {
      label.textContent = 'Search';
      var kbd2 = btn.querySelector('kbd'); if (kbd2) kbd2.style.display = '';
    }
  }

  function renderEmpty() {
    var cells = '';
    for (var i = 0; i < 36; i++) {
      cells += '<div class="ea-cell" style="animation-delay:' + (i*60) + 'ms"></div>';
    }
    var tab = state.activeTab;
    var copy = TAB_LABELS[tab] || TAB_LABELS.issues;
    var titleHtml = esc(copy.empty).replace(/\n/g, '<br/>');
    return ''
      + '<div class="empty">'
      +   '<div class="empty-art">'
      +     '<div class="ea-grid">' + cells + '</div>'
      +     '<div class="ea-target"></div>'
      +   '</div>'
      +   '<div class="empty-title">' + titleHtml + '</div>'
      +   '<div class="empty-sub">' + esc(copy.sub) + '</div>'
      + '</div>';
  }

  function renderResults() {
    if (state.activeTab === 'issues') return renderIssuesResults();
    if (state.activeTab === 'repos')  return renderReposResults();
    if (state.activeTab === 'org')    return renderOrgResults();
  }

  function renderTrendingBar(tab) {
    var c = state[tab];
    var tf = c.timeframe;
    var tfs = ['daily', 'weekly', 'monthly'];
    var labels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
    var subs = { daily: 'last 24h', weekly: 'last 7d', monthly: 'last 30d' };
    var html = '<div class="timeframe-bar" role="tablist">';
    for (var i = 0; i < tfs.length; i++) {
      var k = tfs[i];
      html += '<button class="tf ' + (k === tf ? 'active' : '') + '" data-tf="' + k + '" role="tab" aria-selected="' + (k === tf) + '">'
        +   '<span class="tf-label">' + labels[k] + '</span>'
        +   '<span class="tf-sub">' + subs[k] + '</span>'
        +   '<span class="tf-n">top ' + tfCount(k) + '</span>'
        + '</button>';
    }
    return html + '</div>';
  }

  function renderStatsStrip(num, labelHtml) {
    var dateStr = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return ''
      + '<div class="stats-strip">'
      +   '<div class="stat-main">'
      +     '<div class="stat-num" id="stat-num">' + (num != null ? num.toLocaleString() : '0') + '</div>'
      +     '<div class="stat-label">' + labelHtml + '</div>'
      +   '</div>'
      +   '<div class="stat-side">'
      +     '<div class="stat-pip"><span class="dot live"></span> live · github api</div>'
      +     '<div class="stat-meta">indexed ' + esc(dateStr) + ', ' + esc(timeStr) + '</div>'
      +   '</div>'
      + '</div>';
  }

  function renderIssuesResults() {
    var slot = $('results-slot');
    var c = state.issues;
    if (!c.searched && !c.searching) { slot.innerHTML = renderEmpty(); return; }
    if (!c.searched) { slot.innerHTML = ''; return; }

    var s = c.searched;
    var tf = c.timeframe;
    var langChip = s.language ? '<span class="mono">' + esc(s.language) + '</span>' : '';
    var topicChip = s.topic ? ' · <span class="mono">' + esc(s.topic) + '</span>' : '';
    var lblHtml = 'open issues on GitHub matching ' + (langChip || topicChip ? (langChip + topicChip) : '<span class="mono">your search</span>');

    var html = renderStatsStrip(s.total, lblHtml);
    html += renderTrendingBar('issues');
    html += ''
      + '<div class="results-head">'
      +   '<div class="results-title">'
      +     '<span class="rh-em">Top ' + tfCount(tf) + '</span>'
      +     '<span class="muted"> issues updated in the last </span>'
      +     '<span class="rh-em">' + tfWindow(tf) + '</span>'
      +     '<span class="muted">, sorted by reactions</span>'
      +   '</div>'
      +   '<div class="results-actions">'
      +     '<button class="link-btn" disabled>Sort: reactions ▾</button>'
      +     '<button class="link-btn" id="export-btn">Export</button>'
      +   '</div>'
      + '</div>';

    html += '<div class="issues">';
    var data = c.dataByTf[tf] || [];
    if (c.loadingTf || (c.searching && !data.length)) {
      for (var j = 0; j < 6; j++) html += '<div class="issue skel"></div>';
    } else if (!data.length) {
      html += '<div class="empty" style="padding:30px 0"><div class="empty-sub">No issues found for this filter.</div></div>';
    } else {
      for (var ix = 0; ix < data.length; ix++) html += renderIssueCard(data[ix], ix);
    }
    html += '</div>';

    slot.innerHTML = html;
  }

  function renderReposResults() {
    var slot = $('results-slot');
    var c = state.repos;
    if (!c.searched && !c.searching) { slot.innerHTML = renderEmpty(); return; }
    if (!c.searched) { slot.innerHTML = ''; return; }

    var s = c.searched;
    var tf = c.timeframe;
    var langChip = s.language ? '<span class="mono">' + esc(s.language) + '</span>' : '';
    var topicChip = s.topic ? ' · <span class="mono">' + esc(s.topic) + '</span>' : '';
    var lblHtml = 'public repositories on GitHub matching ' + (langChip || topicChip ? (langChip + topicChip) : '<span class="mono">your search</span>');

    var html = renderStatsStrip(s.total, lblHtml);
    html += renderTrendingBar('repos');
    html += ''
      + '<div class="results-head">'
      +   '<div class="results-title">'
      +     '<span class="rh-em">Top ' + tfCount(tf) + '</span>'
      +     '<span class="muted"> repositories pushed in the last </span>'
      +     '<span class="rh-em">' + tfWindow(tf) + '</span>'
      +     '<span class="muted">, sorted by stars</span>'
      +   '</div>'
      +   '<div class="results-actions">'
      +     '<button class="link-btn" disabled>Sort: stars ▾</button>'
      +     '<button class="link-btn" id="export-btn">Export</button>'
      +   '</div>'
      + '</div>';

    html += '<div class="issues">';
    var data = c.dataByTf[tf] || [];
    if (c.loadingTf || (c.searching && !data.length)) {
      for (var j = 0; j < 6; j++) html += '<div class="issue skel"></div>';
    } else if (!data.length) {
      html += '<div class="empty" style="padding:30px 0"><div class="empty-sub">No repositories found for this filter.</div></div>';
    } else {
      for (var ix = 0; ix < data.length; ix++) html += renderRepoCard(data[ix], ix);
    }
    html += '</div>';

    slot.innerHTML = html;
  }

  function renderOrgResults() {
    var slot = $('results-slot');
    var c = state.org;
    if (!c.info && !c.searching) { slot.innerHTML = renderEmpty(); return; }
    if (!c.info) { slot.innerHTML = ''; return; }

    var info = c.info;
    var blogLink = info.blog ? '<a href="' + esc(info.blog.indexOf('http') === 0 ? info.blog : 'https://' + info.blog) + '" target="_blank" rel="noopener">' + esc(info.blog) + '</a>' : '';
    var html = ''
      + '<div class="org-banner">'
      +   (info.avatarUrl ? '<img class="org-avatar" src="' + esc(info.avatarUrl) + '" alt=""/>' : '')
      +   '<div class="org-meta">'
      +     '<div class="org-name">' + esc(info.name || info.login) + '</div>'
      +     (info.description ? '<div class="org-desc">' + esc(info.description) + '</div>' : '')
      +     '<div class="org-stats">'
      +       '<span><strong style="color:var(--text)">' + (info.publicRepos || 0).toLocaleString() + '</strong> public repos</span>'
      +       (blogLink ? '<span>' + blogLink + '</span>' : '')
      +       '<a href="' + esc(info.htmlUrl) + '" target="_blank" rel="noopener">open on github →</a>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    html += ''
      + '<div class="results-head">'
      +   '<div class="results-title">'
      +     '<span class="rh-em">Top topics</span>'
      +     '<span class="muted"> across ' + esc(info.login) + '’s public repositories</span>'
      +     (c.query && c.query.topic ? '<span class="muted">, filtered to </span><span class="mono">' + esc(c.query.topic) + '</span>' : '')
      +   '</div>'
      +   '<div class="results-actions">'
      +     '<button class="link-btn" id="export-btn">Export</button>'
      +   '</div>'
      + '</div>';

    html += '<div class="issues">';
    if (c.searching) {
      for (var j = 0; j < 6; j++) html += '<div class="issue skel"></div>';
    } else if (!c.topics.length) {
      html += '<div class="empty" style="padding:30px 0"><div class="empty-sub">No topics found in this organization' + (c.query && c.query.topic ? ' for ‘' + esc(c.query.topic) + '’' : '') + '.</div></div>';
    } else {
      for (var ix = 0; ix < c.topics.length; ix++) html += renderTopicCard(c.topics[ix], ix, info.login);
    }
    html += '</div>';

    slot.innerHTML = html;
  }

  function renderRepoCard(r, idx) {
    var key = 'repo:' + r.fullName;
    var analysing = !!state.analysing[key];
    var analysis = state.analyses[key];
    var langName = normalizeLang(r.language || '');
    var langColor = LANG_COLOR[langName] || (langName ? '#888' : 'transparent');
    var langSwatch = langName ? '<span class="lang-swatch" style="background:' + esc(langColor) + '" title="' + esc(langName) + '"></span>' : '';
    var ageStr = '';
    if (r.ageDays != null) {
      ageStr = r.ageDays >= 365 ? ('created ' + (r.ageDays / 365).toFixed(1) + 'y ago') : ('created ' + r.ageDays + 'd ago');
    }
    var topics = (r.topics || []).slice(0, 6).map(function(t){
      return '<span class="rc-topic-chip">' + esc(t) + '</span>';
    }).join('');
    var analyseLabel;
    if (analysing) analyseLabel = '<span class="spinner-sm"></span> Analysing';
    else if (analysis) analyseLabel = 'View analysis <span class="sparkle">✦</span>';
    else analyseLabel = '<span class="sparkle">✦</span> Analyse';
    var analyseClasses = 'btn btn-ghost analyse-btn' + (analysing ? ' loading' : '') + (analysis ? ' done' : '');
    return ''
      + '<div class="repo-card" data-key="' + esc(key) + '">'
      +   '<div class="rc-rank">' + String(idx + 1).padStart(2, '0') + '</div>'
      +   '<div class="rc-body">'
      +     '<div class="rc-meta">'
      +       langSwatch
      +       '<a class="rc-name" href="' + esc(r.htmlUrl) + '" target="_blank" rel="noopener">' + esc(r.fullName) + '</a>'
      +       '<span class="rc-stars"><span class="ic">★</span> ' + (r.stars || 0).toLocaleString() + '</span>'
      +       (ageStr ? '<span class="dot-sep">·</span><span class="muted">' + esc(ageStr) + '</span>' : '')
      +     '</div>'
      +     (r.description ? '<div class="rc-desc">' + esc(r.description) + '</div>' : '')
      +     (topics ? '<div class="rc-topics">' + topics + '</div>' : '')
      +     '<div class="rc-footer">'
      +       '<span class="rc-issues">' + (r.openIssues || 0).toLocaleString() + ' open issues</span>'
      +       '<div class="spacer"></div>'
      +       '<button class="' + analyseClasses + '" data-analyse-repo="' + esc(r.fullName) + '"' + (analysing ? ' disabled' : '') + '>' + analyseLabel + '</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function renderTopicCard(t, idx, orgLogin) {
    var key = 'topic:' + orgLogin + '::' + t.name;
    var analysing = !!state.analysing[key];
    var analysis = state.analyses[key];
    var sampleRepos = (t.sampleRepos || []).slice(0, 4).map(function(r){
      return '<a class="tc-repo-link" href="' + esc(r.htmlUrl) + '" target="_blank" rel="noopener">' + esc(r.fullName) + '</a>';
    }).join('');
    var langs = (t.languages || []).slice(0, 6).map(function(l){
      var n = normalizeLang(l); var color = LANG_COLOR[n] || '#888';
      return '<span class="rc-topic-chip" style="border-color:' + esc(color) + ';color:' + esc(color) + '">' + esc(l) + '</span>';
    }).join('');
    var analyseLabel;
    if (analysing) analyseLabel = '<span class="spinner-sm"></span> Analysing';
    else if (analysis) analyseLabel = 'View analysis <span class="sparkle">✦</span>';
    else analyseLabel = '<span class="sparkle">✦</span> Analyse';
    var analyseClasses = 'btn btn-ghost analyse-btn' + (analysing ? ' loading' : '') + (analysis ? ' done' : '');
    return ''
      + '<div class="topic-card" data-key="' + esc(key) + '">'
      +   '<div class="tc-rank">' + String(idx + 1).padStart(2, '0') + '</div>'
      +   '<div class="tc-body">'
      +     '<div class="tc-name">#' + esc(t.name) + '</div>'
      +     '<div class="tc-stats">'
      +       '<span class="tc-stat"><strong>' + (t.repoCount || 0).toLocaleString() + '</strong> repos</span>'
      +       '<span class="dot-sep">·</span>'
      +       '<span class="tc-stat"><span class="ic">★</span> <strong>' + (t.totalStars || 0).toLocaleString() + '</strong> total</span>'
      +       '<span class="dot-sep">·</span>'
      +       '<span class="tc-stat"><strong>' + (t.totalOpenIssues || 0).toLocaleString() + '</strong> open issues</span>'
      +     '</div>'
      +     (sampleRepos ? '<div class="tc-repos">' + sampleRepos + '</div>' : '')
      +     '<div class="tc-footer">'
      +       (langs ? '<div class="tc-langs">' + langs + '</div>' : '')
      +       '<div class="spacer"></div>'
      +       '<button class="' + analyseClasses + '" data-analyse-topic="' + esc(orgLogin) + '::' + esc(t.name) + '"' + (analysing ? ' disabled' : '') + '>' + analyseLabel + '</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function renderIssueCard(iss, idx) {
    var k = 'issue:' + issueKey(iss);
    var analysing = !!state.analysing[k];
    var analysis = state.analyses[k];
    var langName = normalizeLang(iss.lang || (state.issues.searched && state.issues.searched.language) || '');
    var langColor = LANG_COLOR[langName] || (langName ? '#888' : 'transparent');
    var langSwatch = langName ? '<span class="lang-swatch" style="background:' + esc(langColor) + '" title="' + esc(langName) + '"></span>' : '';
    var hours = '';
    if (iss.createdAt && (iss.ageDays === 0 || iss.ageDays == null)) {
      var totalH = Math.floor((Date.now() - new Date(iss.createdAt).getTime()) / 3600000);
      hours = isNaN(totalH) ? '' : (totalH + 'h ago');
    }
    var ageStr = iss.ageDays != null ? formatAge(iss.ageDays, 0) : hours;
    if (iss.ageDays === 0 && hours) ageStr = hours;

    var labels = (iss.labels || []).slice(0, 5).map(function(l){
      return '<span class="' + esc(safeLabelClass(l)) + '">' + esc(l) + '</span>';
    }).join('');

    var url = iss.url || '#';
    var title = esc(iss.title || '(untitled)');

    var staleBadge = iss.isStale ? '<span class="badge badge-stale">stale</span>' : '';
    var commentsPill = iss.comments != null
      ? '<div class="comments-pill"><span class="ic">💬</span> ' + iss.comments + '</div>'
      : '';

    var analyseLabel;
    if (analysing) {
      analyseLabel = '<span class="spinner-sm"></span> Analysing';
    } else if (analysis) {
      analyseLabel = 'View analysis <span class="sparkle">✦</span>';
    } else {
      analyseLabel = '<span class="sparkle">✦</span> Analyse';
    }
    var analyseClasses = 'btn btn-ghost analyse-btn' + (analysing ? ' loading' : '') + (analysis ? ' done' : '');

    return ''
      + '<div class="issue" data-key="' + esc(k) + '">'
      +   '<div class="issue-rank">' + String(idx + 1).padStart(2, '0') + '</div>'
      +   '<div class="issue-body">'
      +     '<div class="issue-meta">'
      +       langSwatch
      +       '<span class="repo mono">' + esc(iss.repo || '') + '</span>'
      +       '<span class="dot-sep">·</span>'
      +       '<span class="muted mono">#' + esc(String(iss.number || '')) + '</span>'
      +       (ageStr ? '<span class="dot-sep">·</span><span class="muted">' + esc(ageStr) + '</span>' : '')
      +       staleBadge
      +     '</div>'
      +     '<a class="issue-title" href="' + esc(url) + '" target="_blank" rel="noopener">' + title + '</a>'
      +     '<div class="issue-footer">'
      +       (iss.reactions ? '<div class="reactions"><span class="r-up">▲</span> <span class="r-n">+' + iss.reactions + '</span></div>' : '')
      +       commentsPill
      +       '<div class="labels">' + labels + '</div>'
      +       '<div class="spacer"></div>'
      +       '<button class="' + analyseClasses + '" data-analyse="' + esc(k) + '"' + (analysing ? ' disabled' : '') + '>' + analyseLabel + '</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function row(key, val) {
    return '<div class="a-row"><div class="a-key">' + esc(key) + '</div><div class="a-val">' + esc(val || '—') + '</div></div>';
  }

  // ---------- Count-up animation ----------
  function animateCount(target, duration) {
    duration = duration || 900;
    var node = $('stat-num');
    if (!node) return;
    var start = performance.now();
    function tick(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var v = Math.round(target * eased);
      node.textContent = v.toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---------- Modal (settings) ----------
  function renderModal() {
    var slot = $('modal-slot');
    if (!state.settingsOpen) { slot.innerHTML = ''; return; }
    var s = state.modalDraft || { provider: state.settings.provider, apiKey: state.settings.apiKey, model: state.settings.model, showKey: false };
    state.modalDraft = s;

    var providerCards = PROVIDERS.map(function(pr){
      var sel = s.provider === pr.id;
      return ''
        + '<button type="button" class="provider-card ' + (sel ? 'selected' : '') + '" data-pick-provider="' + pr.id + '">'
        +   '<div class="pc-glyph">' + pr.glyph + '</div>'
        +   '<div class="pc-text">'
        +     '<div class="pc-name">' + esc(pr.label) + '</div>'
        +     '<div class="pc-model mono">' + esc(pr.defaultModel) + '</div>'
        +   '</div>'
        +   '<div class="pc-radio">' + (sel ? '<div class="pc-dot"></div>' : '') + '</div>'
        + '</button>';
    }).join('');

    var valid = (s.apiKey || '').trim().length > 6 && (s.model || '').trim().length > 0;
    var statusHtml = valid
      ? '<span class="dot ok"></span> Ready'
      : '<span class="dot warn"></span> Add an API key';

    var placeholder = providerInfo(s.provider).placeholder;

    slot.innerHTML = ''
      + '<div class="modal-scrim" id="modal-scrim">'
      +   '<div class="modal" role="dialog" aria-label="AI Settings" id="modal-panel">'
      +     '<div class="modal-head">'
      +       '<div>'
      +         '<div class="modal-title">AI Settings</div>'
      +         '<div class="modal-sub">Bring your own key — calls are proxied locally, key stays in your browser.</div>'
      +       '</div>'
      +       '<button class="icon-btn" id="modal-close" aria-label="Close">✕</button>'
      +     '</div>'
      +     '<div class="modal-body">'
      +       '<div class="form-row">'
      +         '<label>Provider</label>'
      +         '<div class="provider-grid">' + providerCards + '</div>'
      +       '</div>'
      +       '<div class="form-row">'
      +         '<label>API Key</label>'
      +         '<div class="input-wrap key-wrap">'
      +           '<span class="input-icon">⚿</span>'
      +           '<input id="modal-key" type="' + (s.showKey ? 'text' : 'password') + '" value="' + esc(s.apiKey) + '" placeholder="' + esc(placeholder) + '" spellcheck="false" autocomplete="off"/>'
      +           '<button type="button" class="ghost-mini" id="toggle-key">' + (s.showKey ? 'hide' : 'show') + '</button>'
      +         '</div>'
      +         '<div class="form-help">Stored in <span class="mono">localStorage</span>. Never sent anywhere except the provider above.</div>'
      +       '</div>'
      +       '<div class="form-row">'
      +         '<label>Model <span class="opt">editable</span></label>'
      +         '<div class="input-wrap">'
      +           '<span class="input-icon mono">m</span>'
      +           '<input id="modal-model" value="' + esc(s.model) + '" spellcheck="false" autocomplete="off"/>'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +     '<div class="modal-foot">'
      +       '<div class="foot-status">' + statusHtml + '</div>'
      +       '<div class="foot-actions">'
      +         '<button class="btn btn-ghost" id="modal-cancel">Cancel</button>'
      +         '<button class="btn btn-primary" id="modal-save"' + (valid ? '' : ' disabled') + '>Save</button>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function renderAnalysisModal() {
    var slot = $('analysis-modal-slot');
    if (!state.analysisOpenFor) { slot.innerHTML = ''; return; }
    var key = state.analysisOpenFor;
    var analysis = state.analyses[key];
    if (!analysis) { slot.innerHTML = ''; return; }

    var rowsHtml = (analysis.rows || []).map(function(r){
      return row(r.key, r.val);
    }).join('');

    var sub1 = analysis.subtitleLines && analysis.subtitleLines[0] ? '<span class="mono small muted">' + esc(analysis.subtitleLines[0]) + '</span><br/>' : '';
    var sub2 = analysis.subtitleLines && analysis.subtitleLines[1] ? esc(analysis.subtitleLines[1]) : '';

    slot.innerHTML = ''
      + '<div class="modal-scrim" id="analysis-scrim">'
      +   '<div class="modal modal-wide" role="dialog" aria-label="' + esc(analysis.title || 'Analysis') + '">'
      +     '<div class="modal-head">'
      +       '<div>'
      +         '<div class="modal-title">' + esc(analysis.title || 'Analysis') + '</div>'
      +         (sub1 || sub2 ? '<div class="modal-title-issue">' + sub1 + sub2 + '</div>' : '')
      +       '</div>'
      +       '<button class="icon-btn" id="analysis-close" aria-label="Close">✕</button>'
      +     '</div>'
      +     '<div class="modal-body">'
      +       '<div class="analysis-grid">' + rowsHtml + '</div>'
      +     '</div>'
      +     '<div class="modal-foot">'
      +       '<span class="mono small muted">via ' + esc(analysis.providerLabel || '') + ' · ' + esc(analysis.model || '') + '</span>'
      +       (analysis.externalUrl ? '<a class="modal-foot-link" href="' + esc(analysis.externalUrl) + '" target="_blank" rel="noopener">' + esc(analysis.externalLabel || 'Open on GitHub →') + '</a>' : '')
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function openModal() {
    state.modalDraft = {
      provider: state.settings.provider,
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      showKey: false
    };
    state.settingsOpen = true;
    renderModal();
  }
  function closeModal() {
    state.settingsOpen = false;
    state.modalDraft = null;
    renderModal();
  }

  // ---------- Event handlers ----------
  function bindHeader() {
    $('open-settings').addEventListener('click', openModal);
  }
  function bindTabs() {
    document.querySelectorAll('.tab-pill').forEach(function(btn){
      btn.addEventListener('click', function(){
        setActiveTab(btn.getAttribute('data-tab'));
      });
    });
  }
  function setActiveTab(name) {
    if (name !== 'issues' && name !== 'repos' && name !== 'org') return;
    state.activeTab = name;
    document.querySelectorAll('.tab-pill').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    var lt = $('search-form-lt'); var og = $('search-form-org');
    lt.style.display = (name === 'org') ? 'none' : '';
    og.style.display = (name === 'org') ? '' : 'none';
    setError('');
    updateSearchButton();
    renderResults();
    // focus the right input
    if (name === 'org') { $('org-input').focus(); }
    else { $('lang-input').focus(); }
  }

  function bindSearch() {
    var formLt = $('search-form-lt');
    formLt.addEventListener('submit', function(e){ e.preventDefault(); runSearch(); });
    $('lang-input').addEventListener('input', updateSearchButton);
    $('topic-input').addEventListener('input', updateSearchButton);
    var formOrg = $('search-form-org');
    formOrg.addEventListener('submit', function(e){ e.preventDefault(); runSearchOrg(); });
    $('org-input').addEventListener('input', updateSearchButton);
    $('org-topic-input').addEventListener('input', updateSearchButton);
    document.querySelectorAll('.chip-suggest').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (btn.classList.contains('org-chip')) {
          $('org-input').value = btn.getAttribute('data-o') || '';
          $('org-topic-input').value = btn.getAttribute('data-t') || '';
          updateSearchButton();
          runSearchOrg();
        } else {
          $('lang-input').value = btn.getAttribute('data-l') || '';
          $('topic-input').value = btn.getAttribute('data-t') || '';
          updateSearchButton();
          runSearch();
        }
      });
    });
  }
  function bindResultsClicks() {
    var slot = $('results-slot');
    slot.addEventListener('click', function(e){
      var tfBtn = e.target.closest && e.target.closest('[data-tf]');
      if (tfBtn) { selectTimeframe(tfBtn.getAttribute('data-tf')); return; }
      var aIssue = e.target.closest && e.target.closest('[data-analyse]');
      if (aIssue) { onAnalyseIssue(aIssue.getAttribute('data-analyse')); return; }
      var aRepo  = e.target.closest && e.target.closest('[data-analyse-repo]');
      if (aRepo)  { onAnalyseRepo(aRepo.getAttribute('data-analyse-repo')); return; }
      var aTopic = e.target.closest && e.target.closest('[data-analyse-topic]');
      if (aTopic) { onAnalyseTopic(aTopic.getAttribute('data-analyse-topic')); return; }
      if (e.target.id === 'export-btn') { exportJSON(); return; }
    });
  }
  function bindModalClicks() {
    document.body.addEventListener('click', function(e){
      // Analysis popup
      if (state.analysisOpenFor) {
        if (e.target.id === 'analysis-scrim') { closeAnalysisModal(); return; }
        if (e.target.id === 'analysis-close' || (e.target.closest && e.target.closest('#analysis-close'))) { closeAnalysisModal(); return; }
      }
      if (!state.settingsOpen) return;
      if (e.target.id === 'modal-scrim') { closeModal(); return; }
      if (e.target.id === 'modal-close' || e.target.closest('#modal-close')) { closeModal(); return; }
      if (e.target.id === 'modal-cancel') { closeModal(); return; }
      if (e.target.id === 'modal-save')   { onSaveSettings(); return; }
      if (e.target.id === 'toggle-key')   { state.modalDraft.showKey = !state.modalDraft.showKey; renderModal(); return; }
      var pickProv = e.target.closest && e.target.closest('[data-pick-provider]');
      if (pickProv) {
        var newP = pickProv.getAttribute('data-pick-provider');
        var prevModel = state.modalDraft.model;
        state.modalDraft.provider = newP;
        // auto-fill model if previous was a default of some provider
        var prevWasDefault = PROVIDERS.some(function(p){ return p.defaultModel === prevModel; });
        if (!prevModel || prevWasDefault) {
          state.modalDraft.model = providerInfo(newP).defaultModel;
        }
        renderModal();
        return;
      }
    });
    document.body.addEventListener('input', function(e){
      if (!state.settingsOpen) return;
      if (e.target.id === 'modal-key')   { state.modalDraft.apiKey = e.target.value; refreshFootStatus(); }
      if (e.target.id === 'modal-model') { state.modalDraft.model  = e.target.value; refreshFootStatus(); }
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') {
        if (state.analysisOpenFor) { closeAnalysisModal(); return; }
        if (state.settingsOpen) closeModal();
      }
    });
  }

  function refreshFootStatus() {
    var s = state.modalDraft;
    var valid = (s.apiKey || '').trim().length > 6 && (s.model || '').trim().length > 0;
    var foot = document.querySelector('.foot-status');
    if (foot) foot.innerHTML = valid ? '<span class="dot ok"></span> Ready' : '<span class="dot warn"></span> Add an API key';
    var saveBtn = $('modal-save');
    if (saveBtn) saveBtn.disabled = !valid;
  }

  function onSaveSettings() {
    var s = state.modalDraft;
    saveSettings({ provider: s.provider, apiKey: (s.apiKey || '').trim(), model: (s.model || '').trim() });
    closeModal();
    renderResults();
  }

  async function runSearch() {
    var tab = state.activeTab === 'org' ? 'issues' : state.activeTab;
    var lang = $('lang-input').value.trim();
    var topic = $('topic-input').value.trim();
    if (!lang && !topic) return;
    setError('');
    var c = state[tab];
    c.searching = true;
    c.searched = null;
    c.dataByTf = {};
    c.timeframe = 'weekly';
    updateSearchButton();
    renderResults();
    try {
      var countResp = tab === 'repos' ? await apiCountRepos(lang, topic) : await apiCount(lang, topic);
      if (countResp.error) { setError(countResp.error); c.searching = false; updateSearchButton(); renderResults(); return; }
      c.searched = { language: lang, topic: topic, total: countResp.totalCount || 0 };

      var t = tab === 'repos'
        ? await apiTrendingRepos(lang, topic, 'weekly')
        : await apiTrending(lang, topic, 'weekly');
      if (t.error) setError(t.error);
      c.dataByTf.weekly = tab === 'repos' ? (t.repos || []) : (t.issues || []);
      c.searching = false;
      updateSearchButton();
      renderResults();
      animateCount(c.searched.total);
    } catch (e) {
      setError(e && e.message ? e.message : 'Search failed.');
      c.searching = false;
      updateSearchButton();
      renderResults();
    }
  }

  async function runSearchOrg() {
    var org = $('org-input').value.trim();
    var topic = $('org-topic-input').value.trim();
    if (!org) return;
    setError('');
    state.org.searching = true;
    state.org.info = null;
    state.org.topics = [];
    state.org.query = { org: org, topic: topic };
    updateSearchButton();
    renderResults();
    try {
      var r = await apiOrgTopics(org, topic);
      if (r.error) { setError(r.error); state.org.searching = false; updateSearchButton(); renderResults(); return; }
      state.org.info = r.info;
      state.org.topics = r.topics || [];
      state.org.searching = false;
      updateSearchButton();
      renderResults();
      if (state.org.info) animateCount(state.org.info.publicRepos || 0);
    } catch (e) {
      setError(e && e.message ? e.message : 'Search failed.');
      state.org.searching = false;
      updateSearchButton();
      renderResults();
    }
  }

  async function selectTimeframe(tf) {
    var tab = state.activeTab === 'org' ? null : state.activeTab;
    if (!tab) return;
    var c = state[tab];
    if (c.timeframe === tf && c.dataByTf[tf]) return;
    c.timeframe = tf;
    if (!c.dataByTf[tf]) {
      c.loadingTf = true;
      renderResults();
      try {
        var t = tab === 'repos'
          ? await apiTrendingRepos(c.searched.language, c.searched.topic, tf)
          : await apiTrending(c.searched.language, c.searched.topic, tf);
        if (t.error) { setError(t.error); c.dataByTf[tf] = []; }
        else c.dataByTf[tf] = tab === 'repos' ? (t.repos || []) : (t.issues || []);
      } catch (e) {
        setError(e && e.message ? e.message : 'Failed to load.');
        c.dataByTf[tf] = [];
      }
      c.loadingTf = false;
    }
    renderResults();
  }

  async function onAnalyseIssue(issueKeyRaw) {
    if (!state.settings.apiKey) { openModal(); return; }
    var key = 'issue:' + issueKeyRaw;
    if (state.analyses[key]) { openAnalysisModal(key); return; }
    var c = state.issues;
    var issue = (c.dataByTf[c.timeframe] || []).find(function(it){ return issueKey(it) === issueKeyRaw; });
    if (!issue) return;
    state.analysing[key] = true; renderResults();
    try {
      var r = await apiAnalyse(issue);
      var prov = providerInfo(state.settings.provider);
      if (r.error) {
        state.analyses[key] = makeErrAnalysis('Issue Analysis', issue.repo + ' · #' + issue.number, issue.title, issue.url, r.error, prov);
      } else {
        var parsed = parseAnalysis(r.summary);
        state.analyses[key] = {
          title: 'Issue Analysis',
          subtitleLines: [issue.repo + ' · #' + issue.number, issue.title || ''],
          rows: [
            { key: 'Product',       val: parsed.product || (r.summary || '').slice(0, 220) },
            { key: 'Languages',     val: parsed.languages || '' },
            { key: 'Issue summary', val: parsed.summary || (parsed.product ? '' : (r.summary || '')) }
          ],
          providerLabel: prov.label.split(' ')[0],
          model: state.settings.model || prov.defaultModel,
          externalUrl: issue.url || '',
          externalLabel: 'Open issue on GitHub →'
        };
      }
    } catch (e) {
      state.analyses[key] = makeErrAnalysis('Issue Analysis', issue.repo, issue.title, issue.url, e && e.message, providerInfo(state.settings.provider));
    }
    state.analysing[key] = false;
    renderResults();
    openAnalysisModal(key);
  }

  async function onAnalyseRepo(fullName) {
    if (!state.settings.apiKey) { openModal(); return; }
    var key = 'repo:' + fullName;
    if (state.analyses[key]) { openAnalysisModal(key); return; }
    state.analysing[key] = true; renderResults();
    try {
      var r = await apiAnalyseRepo(fullName);
      var prov = providerInfo(state.settings.provider);
      if (r.error) {
        state.analyses[key] = makeErrAnalysis('Repository Analysis', fullName, '', 'https://github.com/' + fullName, r.error, prov);
      } else {
        var rows = parseRepoAnalysis(r.summary);
        state.analyses[key] = {
          title: 'Repository Analysis',
          subtitleLines: [fullName, (r.info && r.info.stars ? r.info.stars.toLocaleString() + ' stars · ' : '') + ((r.info && r.info.openIssues) || 0) + ' open issues'],
          rows: rows,
          providerLabel: prov.label.split(' ')[0],
          model: state.settings.model || prov.defaultModel,
          externalUrl: 'https://github.com/' + fullName,
          externalLabel: 'Open repo on GitHub →'
        };
      }
    } catch (e) {
      state.analyses[key] = makeErrAnalysis('Repository Analysis', fullName, '', 'https://github.com/' + fullName, e && e.message, providerInfo(state.settings.provider));
    }
    state.analysing[key] = false;
    renderResults();
    openAnalysisModal(key);
  }

  async function onAnalyseTopic(composite) {
    if (!state.settings.apiKey) { openModal(); return; }
    var parts = composite.split('::');
    var org = parts[0]; var topic = parts.slice(1).join('::');
    var key = 'topic:' + org + '::' + topic;
    if (state.analyses[key]) { openAnalysisModal(key); return; }
    state.analysing[key] = true; renderResults();
    try {
      var r = await apiAnalyseTopic(org, topic);
      var prov = providerInfo(state.settings.provider);
      if (r.error) {
        state.analyses[key] = makeErrAnalysis('Topic Analysis', '#' + topic, 'in ' + org, 'https://github.com/topics/' + encodeURIComponent(topic), r.error, prov);
      } else {
        var rows = parseTopicAnalysis(r.summary);
        var stat = r.topic || {};
        state.analyses[key] = {
          title: 'Topic Analysis',
          subtitleLines: ['#' + topic + ' · org: ' + org, (stat.repoCount || 0) + ' repos · ' + (stat.totalStars || 0).toLocaleString() + ' stars · ' + (stat.totalOpenIssues || 0).toLocaleString() + ' open issues'],
          rows: rows,
          providerLabel: prov.label.split(' ')[0],
          model: state.settings.model || prov.defaultModel,
          externalUrl: 'https://github.com/topics/' + encodeURIComponent(topic),
          externalLabel: 'Open topic on GitHub →'
        };
      }
    } catch (e) {
      state.analyses[key] = makeErrAnalysis('Topic Analysis', '#' + topic, 'in ' + org, 'https://github.com/topics/' + encodeURIComponent(topic), e && e.message, providerInfo(state.settings.provider));
    }
    state.analysing[key] = false;
    renderResults();
    openAnalysisModal(key);
  }

  function makeErrAnalysis(title, line1, line2, url, errMsg, prov) {
    return {
      title: title,
      subtitleLines: [line1 || '', line2 || ''],
      rows: [{ key: 'Error', val: String(errMsg || 'Unknown error') }],
      providerLabel: prov ? prov.label.split(' ')[0] : '',
      model: state.settings.model || (prov && prov.defaultModel) || '',
      externalUrl: url || '',
      externalLabel: 'Open on GitHub →'
    };
  }

  function openAnalysisModal(key) {
    state.analysisOpenFor = key;
    renderAnalysisModal();
  }
  function closeAnalysisModal() {
    state.analysisOpenFor = null;
    renderAnalysisModal();
  }

  function exportJSON() {
    var tab = state.activeTab;
    var c = state[tab];
    var data;
    if (tab === 'org') {
      data = { tab: 'org', org: c.info, topics: c.topics, query: c.query, analyses: state.analyses };
    } else {
      data = {
        tab: tab,
        searched: c.searched,
        timeframe: c.timeframe,
        items: c.dataByTf[c.timeframe] || [],
        analyses: state.analyses
      };
    }
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var name = tab === 'org' && c.info ? c.info.login : (c.searched && (c.searched.language || c.searched.topic)) || 'export';
    a.download = 'gapscout-' + tab + '-' + name + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ---------- Init ----------
  function init() {
    updateProviderPill();
    bindHeader();
    bindTabs();
    bindSearch();
    bindResultsClicks();
    bindModalClicks();
    updateSearchButton();
    renderResults();
    $('lang-input').focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
</body>
</html>`;

export { app };
