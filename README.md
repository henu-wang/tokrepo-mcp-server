# TokRepo MCP Server

> Agent-native MCP server for TokRepo: session bootstrap, capability discovery, search/detail, trust verification, install planning, Codex staging, lifecycle inspection/update/uninstall/rollback, handoff/harvest planning, and human-confirmed publishing of reusable AI assets.

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
codex mcp add tokrepo -- npx -y tokrepo-mcp-server
gemini settings mcp add tokrepo -- npx -y tokrepo-mcp-server
```

## What It Does

Once connected, your AI assistant can:

- **Discover during planning** — turn a task or capability gap into structured candidate skills, prompts, MCP configs, scripts, and workflows
- **Resolve capability gaps** — select a candidate with verification evidence, install plan, lifecycle contract, next MCP calls, and CLI fallbacks before local build
- **Search** public AI assets by keyword or category with agent fit signals
- **Browse** trending assets, filter by type (MCP, Skill, Prompt, Agent, Script)
- **Get details** — full documentation, install instructions, and metadata
- **Verify trust** — read-only content hash, install plan hash, permission envelope, policy, trust_score_v2, `evidence_bundle`, SBOM-lite, `signature_evidence`, blockers, and warnings
- **Plan before install** — get install plan v2 with policy decisions, rollback, verification, `evidence_bundle`, SBOM-lite, and `signature_evidence`
- **Safe Codex install** — dry-run by default; risky assets must be staged or explicitly approved
- **Lifecycle control** — list, update, uninstall, and roll back managed Codex installs
- **Post-task harvest** — inspect changed or explicit local files with `tokrepo_harvest` before any push, including private package drafts, `quality_gate`, package manifest, SBOM-lite, and provenance
- **Project memory** — pair with `tokrepo init-agent --target all` so future agents know to call TokRepo during planning
- **Discovery surfaces** — official MCP `server.json`, A2A agent card, portable agent manifest, tool catalog, `.well-known`, `agents.txt`, `llms.txt`, and npm metadata are kept machine-readable for agents and registries
- **Funnel visibility** — anonymous aggregate events show whether agents actually discover, plan, install, hand off, and push reusable assets

## Available Tools

| Tool | Description |
|------|-------------|
| `tokrepo_session_init` | Session bootstrap with high-trust assets, project memory pointer, recent handoffs, and policy pack URL |
| `tokrepo_discover` | Planning-time capability discovery from a task, environment, and constraints |
| `tokrepo_resolve_capability` | Resolve a capability gap into a selected asset, verification evidence, install plan, lifecycle contract, next MCP calls, and CLI fallbacks |
| `tokrepo_search` | Search assets by keyword/tag with `agent_fit` ranking |
| `tokrepo_detail` | Get full asset details by UUID |
| `tokrepo_install_plan` | Get agent-native install plan v2 with rollback, evidence_bundle, SBOM-lite, and signature_evidence |
| `tokrepo_verify` | Verify trust, hashes, permissions, policy, evidence_bundle, SBOM-lite, and signature_evidence before activation |
| `tokrepo_codex_install` | Dry-run, stage, or install a Codex skill safely |
| `tokrepo_installed` | List TokRepo-managed Codex installs |
| `tokrepo_update` | Dry-run or update managed Codex installs |
| `tokrepo_uninstall` | Dry-run or remove a managed Codex install |
| `tokrepo_rollback` | Dry-run or roll back a prior Codex install session |
| `tokrepo_handoff_plan` | Read-only packaging plan with quality_gate and package manifest for reusable local work after a task |
| `tokrepo_harvest` | Read-only package draft generator for reusable changed or explicit local files after a task |
| `tokrepo_push` | Push one explicit asset to TokRepo after user confirmation |

## Example Conversations

```
You: "Find me a good MCP server for databases"
AI: [calls tokrepo_resolve_capability] → Ranks DBHub, Supabase MCP, PostgreSQL MCP and returns verification/install-plan evidence for the selected candidate

You: "What video assets should I install?"
AI: [calls tokrepo_resolve_capability] → Finds relevant skills, checks fit, trust, and policy, then asks before installing

You: "Install that cursor rules asset"
AI: [calls tokrepo_verify] → Checks trust_score_v2, permissions, blockers, and warnings
AI: [calls tokrepo_install_plan] → Reviews policy and actions
AI: [calls tokrepo_codex_install with dry_run=false, confirm=true] → Writes only after explicit confirmation
AI: [calls tokrepo_rollback with dry_run=true] → Shows exactly what would be removed before rollback

You: "We created a reusable project rule; save it for future agents"
AI: [calls tokrepo_harvest] → Returns explicit files, hashes, quality_gate, package drafts, SBOM-lite, provenance, metadata defaults, and private-by-default push guidance
AI: [asks for confirmation before tokrepo_push] → Uploads only reviewed files
```

## Make Future Agents Discover TokRepo

Run this once in a project:

```bash
npx tokrepo init-agent --target all
```

It writes managed instructions to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor rules, GitHub Copilot instructions, Cline rules, Windsurf rules, Roo rules, OpenHands microagents, Aider conventions, `.mcp.json`, and `.tokrepo/agent.json`. The rule is simple: during planning, when the agent sees a capability gap, it should call `tokrepo_resolve_capability` or `tokrepo_discover` before inventing a one-off local tool. After a task, agents can call `tokrepo_harvest` or run `tokrepo harvest --changed --json` to suggest reusable files for user-confirmed private publishing.

## Machine-Readable Listing

Registries and agents can discover this server through:

- MCP server manifest: [tokrepo.com/.well-known/mcp/server.json](https://tokrepo.com/.well-known/mcp/server.json)
- TokRepo manifest: [tokrepo.com/.well-known/tokrepo.json](https://tokrepo.com/.well-known/tokrepo.json)
- Portable agent manifest: [tokrepo.com/.well-known/agent.json](https://tokrepo.com/.well-known/agent.json)
- A2A agent card: [tokrepo.com/.well-known/agent-card.json](https://tokrepo.com/.well-known/agent-card.json)
- Tool catalog: [tokrepo.com/.well-known/tool-catalog.json](https://tokrepo.com/.well-known/tool-catalog.json)
- Trust manifest: [tokrepo.com/.well-known/tokrepo-trust.json](https://tokrepo.com/.well-known/tokrepo-trust.json)
- Default agent policy pack: [tokrepo.com/policy-packs/default-agent-policy.json](https://tokrepo.com/policy-packs/default-agent-policy.json)
- Eval evidence: [tokrepo.com/evals/agent-discovery.json](https://tokrepo.com/evals/agent-discovery.json)
- Multi-agent compatibility: [tokrepo.com/evals/multi-agent-compatibility.json](https://tokrepo.com/evals/multi-agent-compatibility.json)
- Agent memory schema: [tokrepo.com/schemas/agent-memory.schema.json](https://tokrepo.com/schemas/agent-memory.schema.json)
- Agent evidence bundle schema: [tokrepo.com/schemas/agent-evidence-bundle.schema.json](https://tokrepo.com/schemas/agent-evidence-bundle.schema.json)
- Capability resolution schema: [tokrepo.com/schemas/capability-resolution.schema.json](https://tokrepo.com/schemas/capability-resolution.schema.json)
- Harvest report schema: [tokrepo.com/schemas/harvest-report.schema.json](https://tokrepo.com/schemas/harvest-report.schema.json)
- Handoff package schema: [tokrepo.com/schemas/handoff-package.schema.json](https://tokrepo.com/schemas/handoff-package.schema.json)
- Agent text entry: [tokrepo.com/agents.txt](https://tokrepo.com/agents.txt)
- Agent instructions: [tokrepo.com/agent-instructions/tokrepo.md](https://tokrepo.com/agent-instructions/tokrepo.md)
- Agent ecosystem distribution pack: [tokrepo.com/agent-ecosystem.json](https://tokrepo.com/agent-ecosystem.json)
- LLM crawler entry: [tokrepo.com/llms.txt](https://tokrepo.com/llms.txt)

Use `https://tokrepo.com/agent-ecosystem.json` for agent marketplace submissions, starter templates, README snippets, install guides, and example projects. It contains canonical listing copy, ecosystem channels, target project-memory files, and verification commands.

TokRepo emits anonymous aggregate funnel events for `tokrepo_resolve_capability`, `tokrepo_discover`, `tokrepo_verify`, `tokrepo_install_plan`, install dry-runs, installs, harvests, handoffs, and pushes. It does not send task text or file contents. Disable with `TOKREPO_TELEMETRY=0`.

## Why TokRepo?

TokRepo is the **open registry for AI assets** — like npm for packages, but for AI skills, prompts, MCP configs, and workflows.

- **Curated assets** — quality-reviewed, not a dump
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
