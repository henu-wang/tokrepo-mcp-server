# TokRepo MCP Server

> Search, browse, and install AI assets from [TokRepo](https://tokrepo.com) — the open registry for AI skills, prompts, MCP configs, scripts, and workflows.

[![npm](https://img.shields.io/npm/v/tokrepo-mcp-server)](https://www.npmjs.com/package/tokrepo-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Quick Start

### Claude Code
```bash
claude mcp add tokrepo -- npx tokrepo-mcp-server
```

### Cursor / Windsurf
Add to your MCP config (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "tokrepo": {
      "command": "npx",
      "args": ["tokrepo-mcp-server"]
    }
  }
}
```

### OpenAI Codex / Gemini CLI
```bash
codex --mcp-server tokrepo -- npx tokrepo-mcp-server
gemini settings mcp add tokrepo -- npx tokrepo-mcp-server
```

## What It Does

Once connected, your AI assistant can:

- **Search** 200+ curated AI assets by keyword or category
- **Browse** trending assets, filter by type (MCP, Skill, Prompt, Agent, Script)
- **Get details** — full documentation, install instructions, and metadata
- **Install** — get raw content ready to save or execute

## Available Tools

| Tool | Description |
|------|-------------|
| `tokrepo_search` | Search assets by keyword and tag |
| `tokrepo_detail` | Get full asset details by UUID |
| `tokrepo_install` | Get raw installable content |
| `tokrepo_trending` | Browse popular/latest assets |

## Example Conversations

```
You: "Find me a good MCP server for databases"
AI: [calls tokrepo_search] → Shows DBHub, Supabase MCP, PostgreSQL MCP with install commands

You: "What's trending on TokRepo?"
AI: [calls tokrepo_trending] → Shows top assets by popularity

You: "Install that cursor rules asset"
AI: [calls tokrepo_install] → Returns raw content ready to save
```

## Why TokRepo?

TokRepo is the **open registry for AI assets** — like npm for packages, but for AI skills, prompts, MCP configs, and workflows.

- **200+ curated assets** — quality-reviewed, not a dump
- **Agent-native** — every asset has machine-readable install contracts
- **Universal** — works with Claude Code, Cursor, Codex, Gemini CLI, and any MCP client
- **CLI available** — `npx tokrepo search "query"` / `npx tokrepo install <uuid>`

## Requirements

- Node.js >= 18
- Internet connection (queries tokrepo.com API)

## Links

- **Website**: [tokrepo.com](https://tokrepo.com)
- **CLI**: [npm: tokrepo](https://www.npmjs.com/package/tokrepo)
- **GitHub**: [henu-wang/tokrepo-mcp-server](https://github.com/henu-wang/tokrepo-mcp-server)
- **API**: [tokrepo.com/.well-known/tokrepo.json](https://tokrepo.com/.well-known/tokrepo.json)

## License

MIT
