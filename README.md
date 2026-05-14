# TokRepo MCP Server

> Search, browse, and install AI assets from [TokRepo](https://tokrepo.com) — the open registry for AI skills, prompts, MCP configs, scripts, and workflows.

[![npm](https://img.shields.io/npm/v/tokrepo-mcp-server)](https://www.npmjs.com/package/tokrepo-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Quick Start

### Claude Code
```bash
claude mcp add tokrepo -- npx -y tokrepo-mcp-server
```

### Cursor / Windsurf
Add to your MCP config (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "tokrepo": {
      "command": "npx",
      "args": ["-y", "tokrepo-mcp-server"]
    }
  }
}
```

### OpenAI Codex / Gemini CLI
```bash
codex --mcp-server tokrepo -- npx -y tokrepo-mcp-server
gemini settings mcp add tokrepo -- npx -y tokrepo-mcp-server
```

## What It Does

Once connected, your AI assistant can:

- **Discover during planning** — turn a task or capability gap into structured candidate skills, prompts, MCP configs, scripts, and workflows
- **Search** 200+ curated AI assets by keyword or category with agent fit signals
- **Browse** trending assets, filter by type (MCP, Skill, Prompt, Agent, Script)
- **Get details** — full documentation, install instructions, and metadata
- **Plan before install** — get install plan v2 with policy decisions, rollback, and verification
- **Safe Codex install** — dry-run by default; risky assets must be staged or explicitly approved
- **Lifecycle control** — list, update, uninstall, and roll back managed Codex installs
- **Project memory** — pair with `tokrepo init-agent --target all` so future agents know to call TokRepo during planning
- **Discovery surfaces** — official MCP `server.json`, A2A agent card, portable agent manifest, tool catalog, `.well-known`, `agents.txt`, `llms.txt`, and npm metadata are kept machine-readable for agents and registries
- **Funnel visibility** — anonymous aggregate events show whether agents actually discover, plan, install, hand off, and push reusable assets

## Available Tools

| Tool | Description |
|------|-------------|
| `tokrepo_discover` | Planning-time capability discovery from a task, environment, and constraints |
| `tokrepo_search` | Search assets by keyword/tag with `agent_fit` ranking |
| `tokrepo_detail` | Get full asset details by UUID |
| `tokrepo_install_plan` | Get agent-native install plan v2 |
| `tokrepo_codex_install` | Dry-run, stage, or install a Codex skill safely |
| `tokrepo_installed` | List TokRepo-managed Codex installs |
| `tokrepo_update` | Dry-run or update managed Codex installs |
| `tokrepo_uninstall` | Dry-run or remove a managed Codex install |
| `tokrepo_rollback` | Dry-run or roll back a prior Codex install session |
| `tokrepo_push` | Push one explicit asset to TokRepo after user confirmation |

## Example Conversations

```
You: "Find me a good MCP server for databases"
AI: [calls tokrepo_discover] → Ranks DBHub, Supabase MCP, PostgreSQL MCP as candidate capabilities

You: "What video assets should I install?"
AI: [calls tokrepo_discover] → Finds relevant skills, checks fit and policy, then asks before installing

You: "Install that cursor rules asset"
AI: [calls tokrepo_install_plan] → Reviews policy and actions
AI: [calls tokrepo_codex_install with dry_run=false, confirm=true] → Writes only after explicit confirmation
AI: [calls tokrepo_rollback with dry_run=true] → Shows exactly what would be removed before rollback
```

## Make Future Agents Discover TokRepo

Run this once in a project:

```bash
npx tokrepo init-agent --target all
```

It writes managed instructions to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor rules, GitHub Copilot instructions, Cline rules, Windsurf rules, Roo rules, OpenHands microagents, Aider conventions, and `.mcp.json`. The rule is simple: during planning, when the agent sees a capability gap, it should call `tokrepo_discover` before inventing a one-off local tool. After a task, agents can run `tokrepo agent-handoff --json` to suggest reusable files for user-confirmed private publishing.

## Machine-Readable Listing

Registries and agents can discover this server through:

- MCP server manifest: [tokrepo.com/.well-known/mcp/server.json](https://tokrepo.com/.well-known/mcp/server.json)
- TokRepo manifest: [tokrepo.com/.well-known/tokrepo.json](https://tokrepo.com/.well-known/tokrepo.json)
- Portable agent manifest: [tokrepo.com/.well-known/agent.json](https://tokrepo.com/.well-known/agent.json)
- A2A agent card: [tokrepo.com/.well-known/agent-card.json](https://tokrepo.com/.well-known/agent-card.json)
- Tool catalog: [tokrepo.com/.well-known/tool-catalog.json](https://tokrepo.com/.well-known/tool-catalog.json)
- Agent text entry: [tokrepo.com/agents.txt](https://tokrepo.com/agents.txt)
- Agent instructions: [tokrepo.com/agent-instructions/tokrepo.md](https://tokrepo.com/agent-instructions/tokrepo.md)
- LLM crawler entry: [tokrepo.com/llms.txt](https://tokrepo.com/llms.txt)

TokRepo emits anonymous aggregate funnel events for `tokrepo_discover`, `tokrepo_install_plan`, install dry-runs, installs, handoffs, and pushes. It does not send task text or file contents. Disable with `TOKREPO_TELEMETRY=0`.

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
