<div align="center">

# 🔭 GapScout

**Find the next thing to build on GitHub — before everyone else does.**

An MCP server that surfaces underserved problem spaces on GitHub by analyzing thousands of open issues across popular repos. Works in Claude Code, Claude Desktop, Cursor, Windsurf — any MCP-compatible client.

[Install](#install) · [Usage](#usage) · [How It Works](#how-it-works) · [Roadmap](#roadmap)

</div>

---

## What It Finds

Real output from `find_gaps(language: "rust")` — no curation, raw tool result:

| Gap | Reactions | Repos | Maturity of existing solutions |
|---|---|---|---|
| Type system (specialization/trait aliases) | 1,871 | 11 | Partial workarounds only |
| **Local LLM in Rust tools** | **1,325+** | **8** | **None** |
| Package manager ergonomics (uv) | 1,025 | 12 | PRs open, not merged |
| Rich terminal graphics (sixel) | 654 | 12 | Unmaintained crates |
| Jujutsu VCS tooling | 294+ | 3 | Essentially zero |

Each row = real users actively asking for something, with proof. That `Local LLM in Rust` row? **Demand is loud, supply is zero.** That's a fundable opportunity surfaced in 30 seconds.

---

## Why GapScout

**Most "AI on GitHub" tools answer questions you asked once.** GapScout answers a question you didn't know to ask:

> *"What does the developer community urgently want, that nobody's built yet?"*

It's built for:

- 🚀 **Indie hackers & founders** — validate ideas with demand signal, not gut feel
- 💰 **Early-stage VCs** — scout deal flow in emerging OSS ecosystems
- 🛠 **OSS maintainers** — discover what your users wish existed
- 📈 **Dev-tool PMs** — find adjacent opportunities to your product

---

## How It Works

```
┌──────────────────────────┐
│  Claude Code / Cursor /  │ ← reasoning happens in YOUR LLM
│  any MCP client          │   (your existing subscription)
└────────────┬─────────────┘
             │ MCP stdio
┌────────────▼─────────────┐
│  GapScout MCP server     │ ← this repo
│  ──────────────────────  │
│  • GitHub API fetcher    │
│  • Keyword clustering    │
│  • Gap scoring (stats)   │
└────────────┬─────────────┘
             │
             ▼
        GitHub REST API
```

**No AI on the server.** No vector DB. No external LLM calls from GapScout itself. Just real-time stats over fresh GitHub data — your Claude (or Cursor, or any LLM with tool-use) does the reasoning.

**What this means in practice:** GapScout is BYO-LLM. You need an existing MCP-compatible client (Claude Code, Cursor, Windsurf, etc.) — but GapScout itself adds no extra AI bill on top of what you already pay. The tool also gets smarter every time you upgrade your LLM, without us shipping anything.

---

## Install

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- A GitHub Personal Access Token ([create one](https://github.com/settings/tokens) — only `public_repo` scope needed)
- An MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf, etc.)

### Setup

```bash
git clone https://github.com/sowmyaarajan/gapscout.git
cd gapscout
npm install
npm run build
```

### Wire into Claude Code

```bash
claude mcp add gapscout node "/absolute/path/to/gapscout/dist/index.js" \
  --env GITHUB_TOKEN=ghp_your_token_here \
  --scope user
```

Verify:
```bash
claude mcp list
# → gapscout: node ... - ✓ Connected
```

Restart Claude Code.

### Other Clients

- **Cursor / Windsurf** — add to MCP settings JSON (same `command`/`args`/`env` shape)
- **Claude Desktop** — edit `claude_desktop_config.json` directly

---

## Usage

Just chat naturally:

> *"Use gapscout to find the top 5 gaps in the Rust ecosystem"*

> *"Scan Python — pick the most promising gap and tell me why someone should build it"*

> *"Find popular Go repos that look abandoned and might be worth reviving"*

> *"Compare TypeScript and Rust — where's the bigger unmet need in dev tooling?"*

---

## Tools Exposed

### `find_gaps(language, repoLimit?, issuesPerRepo?, topGaps?)`
Returns ranked gaps with sample issues, demand signals (reactions, comments), affected repos, and abandoned alternatives.

### `list_abandoned(language, repoLimit?)`
Lists popular repos in a language that haven't seen a commit in 12+ months. Useful for finding mature problem spaces where the existing solution has died.

---

## Roadmap

- [x] MVP: stats-based clustering, MCP server, 2 tools
- [x] Cross-repo demand scoring
- [ ] Response caching (reduce GitHub API calls)
- [ ] Semantic clustering (embeddings, not just keywords)
- [ ] Stack Overflow & npm/PyPI/crates.io signal integration
- [ ] Watchlist + email alerts when new gaps emerge
- [ ] `find_emerging_repos` tool (rising stars before they're trending)
- [ ] `compare_ecosystems` tool (which language has the biggest unmet ML/web/CLI gap?)
- [ ] OpenAPI spec for ChatGPT Custom GPTs
- [ ] Public hosted version + web dashboard

---

## Contributing

PRs and issues welcome. This is intentionally a small, focused tool. The core philosophy:

- Stats > AI on the server (keep costs zero)
- The LLM client does the reasoning (we just provide data)
- Real signal > clever scoring

If you find a gap GapScout missed, file an issue with the language + the gap and we'll tune for it.

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Built with [Claude Code](https://claude.com/claude-code). If GapScout finds you a billion-dollar gap, [say hi](https://github.com/sowmyaarajan) — would love to hear what you built.

</div>
