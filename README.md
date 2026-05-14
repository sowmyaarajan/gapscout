<div align="center">

# GapScout

**Find the next thing to build on GitHub — before everyone else does.**

An MCP server + Web UI that surfaces underserved problem spaces on GitHub by analyzing open issues across popular repos. Works in Claude Code, Claude Desktop, Cursor, Windsurf — any MCP-compatible client.

[Install](#install) · [Web UI](#web-ui) · [MCP Tools](#mcp-tools) · [Usage](#usage)

</div>

---

## What It Finds

Real output from `find_gaps(language: "rust")`:

| Gap | Reactions | Repos | Signal |
|---|---|---|---|
| Type system specialization | 1,871 | 11 | Years-old tracking issues, no solution |
| Local LLM tooling in Rust | 1,325+ | 8 | Loud demand, zero supply |
| Package manager ergonomics | 1,025 | 12 | PRs open, never merged |
| Rich terminal graphics (sixel) | 654 | 12 | Unmaintained crates only |

Each row = real users actively asking for something, with proof.

---

## How It Works

```
┌──────────────────────────┐
│  Claude Code / Web UI /  │  ← reasoning happens in YOUR LLM
│  any MCP client          │
└────────────┬─────────────┘
             │ MCP stdio / HTTP
┌────────────▼─────────────┐
│  GapScout server         │  ← this repo
│  • GitHub API fetcher    │
│  • Keyword + bigram      │
│    clustering            │
│  • Gap scoring           │
└────────────┬─────────────┘
             ▼
        GitHub REST API
```

No AI on the server. No vector DB. Just real-time stats over fresh GitHub data.

---

## Install

### Prerequisites

- [Node.js 18+](https://nodejs.org)
- A GitHub Personal Access Token — [create one here](https://github.com/settings/tokens/new) with **no scopes needed** (public data only)

### 1. Clone and build

```bash
git clone https://github.com/sowmyaarajan/gapscout.git
cd gapscout
npm install
npm run build
```

### 2. Add your GitHub token

Create a `.env` file in the project folder:

```
GITHUB_TOKEN=ghp_your_token_here
```

Replace `ghp_your_token_here` with your actual token.

### 3. Wire into Claude Code (MCP)

Run this **as a single line** — replace the path with wherever you cloned the repo:

**Windows (PowerShell):**
```powershell
claude mcp add gapscout --env "GITHUB_TOKEN=ghp_your_token_here" -- node "C:\full\path\to\gapscout\dist\index.js"
```

**Mac / Linux:**
```bash
claude mcp add gapscout --env "GITHUB_TOKEN=ghp_your_token_here" -- node "/full/path/to/gapscout/dist/index.js"
```

Verify it connected:
```bash
claude mcp list
# gapscout: node ... - ✓ Connected
```

Then **restart Claude Code** so it picks up the new tool.

> **Important:** Use the full absolute path to `dist/index.js` — not a relative path.

### Other MCP Clients

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "gapscout": {
      "command": "node",
      "args": ["/full/path/to/gapscout/dist/index.js"],
      "env": { "GITHUB_TOKEN": "ghp_your_token_here" }
    }
  }
}
```

**Cursor / Windsurf** — same `command`/`args`/`env` shape in their MCP settings.

---

## Web UI

GapScout includes a standalone web dashboard — no Claude required.

```bash
npm run ui
```

Then open **http://localhost:3000** in your browser.

The dashboard has 6 tabs:

| Tab | What it does |
|---|---|
| **Find Gaps** | Language-wide gap analysis across top repos |
| **Opportunities** | Issues with few contributors you can pick up and contribute to |
| **Search Issues** | Filter issues by keyword, age, staleness, label, contributor count |
| **Analyze Repo** | Deep-dive any specific repo (e.g. `microsoft/vscode`) |
| **Organization** | Gap analysis across all repos in a GitHub org (e.g. `vercel`) |
| **Abandoned Repos** | Popular repos with no commits in 12+ months |

Results include an **Export JSON** button on every view.

> Keep the terminal running while using the UI — closing it stops the server.

---

## MCP Tools

When used via Claude Code, GapScout exposes 5 tools:

### `find_gaps`
Find underserved problem spaces across popular repos in a language.
```
language        — e.g. "python", "rust", "go", "typescript"
repoLimit       — repos to analyze (5–30, default 15)
issuesPerRepo   — issues per repo (10–50, default 30)
topGaps         — gaps to return (default 10)
```

### `search_issues`
Search issues with filters — great for finding untapped contributions.
```
language        — required
keyword         — filter by title keyword
minAgeDays      — issues open at least N days
maxAgeDays      — issues open at most N days
isStale         — only issues with no recent activity
label           — filter by label (e.g. "good first issue")
maxParticipants — issues with fewer than N participants (find ignored issues)
minReactions    — minimum reaction count
```

### `analyze_repo`
Deep-dive a specific repo.
```
repo            — e.g. "microsoft/vscode", "rust-lang/rust"
issuesPerPage   — issues to fetch (20–100, default 50)
```
Returns: top issues by demand, gap clusters, stale issues, label breakdown, age distribution.

### `analyze_org`
Analyze all public repos in a GitHub organization.
```
org             — e.g. "microsoft", "vercel", "apache"
repoLimit       — repos to scan (5–50, default 20)
language        — optional language filter
issuesPerRepo   — issues per repo (default 30)
topGaps         — gap clusters to return (default 10)
```

### `list_abandoned`
Find popular repos with no commits in 12+ months.
```
language        — e.g. "python"
repoLimit       — repos to check (default 30)
```

---

## Usage

Chat naturally in Claude Code after installing:

```
"Use gapscout to find the top 5 gaps in the Rust ecosystem"

"Search for Python issues about async with fewer than 3 contributors"

"Analyze the microsoft/vscode repo for gaps"

"Find gaps across the vercel organization"

"Find popular Go repos that look abandoned"
```

Or use the Web UI directly at **http://localhost:3000** after running `npm run ui`.

---

## Roadmap

- [x] Gap analysis (language-wide)
- [x] Web UI with 6 tabs
- [x] Issue filtering (age, staleness, contributor count, label)
- [x] Repo deep-dive
- [x] Organization analysis
- [x] Opportunity finder (low-contributor issues)
- [ ] Response caching (reduce GitHub API calls)
- [ ] Semantic clustering (embeddings, not just keywords)
- [ ] Stack Overflow + npm/PyPI/crates.io signal
- [ ] Watchlist + alerts when new gaps emerge

---

## License

MIT — see [LICENSE](LICENSE).
