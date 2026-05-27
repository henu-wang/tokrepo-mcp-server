#!/usr/bin/env node

/**
 * TokRepo MCP Server
 *
 * Search, browse, and install AI assets from TokRepo via the Model Context Protocol.
 * Works with Claude Code, Cursor, Codex, Gemini CLI, and any MCP client.
 *
 * Usage:
 *   claude mcp add tokrepo -- npx -y tokrepo-mcp-server
 *   npx -y tokrepo-mcp-server
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const API_BASE = process.env.TOKREPO_API || 'https://api.tokrepo.com';
const TOKREPO_URL = 'https://tokrepo.com';
const TOKREPO_TOKEN = process.env.TOKREPO_TOKEN || '';
const TOKREPO_CLI = process.env.TOKREPO_CLI || '';
const SERVER_VERSION = '2.16.1';
const MIN_TRUST = Number(process.env.TOKREPO_MIN_TRUST || '0.6');

// ─── MCP Protocol (JSON-RPC over stdio) ───

const SERVER_INFO = {
  name: 'tokrepo',
  version: SERVER_VERSION,
};

const CAPABILITIES = {
  tools: {},
};

const TOOLS = [
  {
    name: 'tokrepo_session_init',
    description: 'Call FIRST at session start (once). Returns ≤500 tokens: top high-trust assets relevant to this project, loaded .tokrepo/agent.json memory pointer, recent handoffs, and policy pack URL. Treat output as authoritative capability inventory for the session. [[tokrepo.session-init-first]]',
    inputSchema: {
      type: 'object',
      properties: {
        project_hint: {
          type: 'string',
          description: 'Optional project signal (path basename, package.json name, or repo description) to bias the asset inventory.',
        },
        target: {
          type: 'string',
          description: 'Optional agent runtime target.',
          enum: ['any', 'all', 'codex', 'claude_code', 'gemini_cli', 'cursor', 'copilot', 'cline', 'windsurf', 'roo', 'openhands', 'aider', 'mcp_client'],
          default: 'any',
        },
        compact: {
          type: 'boolean',
          description: 'Return ultra-compact (≤50 tok per item) per-candidate response. Default true.',
          default: true,
        },
      },
    },
  },
  {
    name: 'tokrepo_find_for_task',
    description: 'ATOMIC ACTION 1 of 3 (find / install / harvest). Find a TokRepo asset for a concrete task. Returns top-N ranked public workflows + match_reasons + install_command + url, backed by /api/v1/tokenboard/agent/find_for_task and counted in the find_for_task funnel step. Use this as the first call when the agent has a task and wants to discover whether an existing asset already solves it. For a broader planning-time capability scan use tokrepo_discover; for the canonical find→install→harvest lifecycle this is the find entry point.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Free-text task description, e.g. "add Stripe webhook handler with idempotency".',
        },
        repo_context: {
          type: 'object',
          description: 'Optional repo signals: language, framework, existing_assets[].',
          additionalProperties: true,
        },
        agent: {
          type: 'string',
          description: 'Optional agent identifier (claude_code, codex, cursor, cline, gemini_cli, copilot, windsurf, roo, openhands).',
        },
        limit: {
          type: 'number',
          description: 'Max candidates (default 3, max 10).',
          default: 3,
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'tokrepo_discover',
    description: 'Planning-time capability discovery for agents. Call this during autonomous planning when the task may need a reusable skill, MCP config, prompt, script, workflow, or other AI asset. Returns structured candidates, fit signals, and next MCP calls. [[tokrepo.discover-before-build]]',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The user goal, subtask, or capability gap the agent is planning for.',
        },
        target: {
          type: 'string',
          description: 'Optional agent/runtime target. Use "any" or "all" for generic cross-agent discovery.',
          enum: ['any', 'all', 'codex', 'claude_code', 'gemini_cli', 'cursor', 'copilot', 'cline', 'windsurf', 'roo', 'openhands', 'aider', 'mcp_client'],
          default: 'any',
        },
        environment: {
          type: 'object',
          description: 'Optional local environment signals, such as project_type, frameworks, language, can_run_shell, can_write_files, or browser_available.',
          additionalProperties: true,
        },
        constraints: {
          type: 'object',
          description: 'Optional constraints such as kind, policy, risk, language, prefer_verified, or must_not_modify_files.',
          additionalProperties: true,
        },
        limit: {
          type: 'number',
          description: 'Max candidates (default 6, max 10)',
          default: 6,
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'tokrepo_resolve_capability',
    description: 'Resolve a planning-time capability gap into a selected TokRepo asset, verification evidence, and install plan. Use this as the default first action when the agent identifies a missing skill, MCP, prompt, script, workflow, or reusable capability. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The user goal, subtask, or capability gap the agent needs to solve.',
        },
        target: {
          type: 'string',
          description: 'Optional agent/runtime target. Use "any" or "all" for generic cross-agent resolution.',
          enum: ['any', 'all', 'codex', 'claude_code', 'gemini_cli', 'cursor', 'copilot', 'cline', 'windsurf', 'roo', 'openhands', 'aider', 'mcp_client'],
          default: 'any',
        },
        environment: {
          type: 'object',
          description: 'Optional local environment signals, such as project_type, frameworks, language, can_run_shell, can_write_files, or browser_available.',
          additionalProperties: true,
        },
        constraints: {
          type: 'object',
          description: 'Optional constraints such as kind, policy, risk, language, prefer_verified, or must_not_modify_files.',
          additionalProperties: true,
        },
        kind: {
          type: 'string',
          description: 'Optional asset kind preference, e.g. skill, prompt, knowledge, mcp_config, script, workflow.',
        },
        policy: {
          type: 'string',
          description: 'Optional install policy preference.',
          enum: ['allow', 'confirm', 'stage_only', 'deny'],
        },
        min_trust: {
          type: 'number',
          description: 'Minimum trust_score_v2 threshold before recommending direct use. Default 70.',
          default: 70,
        },
        min_fit: {
          type: 'number',
          description: 'Minimum fit score threshold before recommending direct use. Default 70.',
          default: 70,
        },
        limit: {
          type: 'number',
          description: 'Max discovery candidates (default 6, max 10).',
          default: 6,
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'tokrepo_search',
    description: 'Search TokRepo for AI assets (skills, prompts, MCP configs, scripts, workflows). Returns matching assets with titles, descriptions, tags, stars, and install commands. Use this when the user asks to find AI tools, MCP servers, skills, prompts, or workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords (e.g. "cursor rules", "mcp database", "claude skill code review")',
        },
        tag: {
          type: 'string',
          description: 'Optional tag filter: agent, coding, efficiency, cost-saving, methodology, data-analysis, writing, marketing, learning, research',
          enum: ['agent', 'coding', 'efficiency', 'cost-saving', 'methodology', 'data-analysis', 'writing', 'marketing', 'learning', 'research'],
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10, max 20)',
          default: 10,
        },
        target: {
          type: 'string',
          description: 'Optional agent target filter. Use "any", "all", or omit it for generic discovery.',
          enum: ['any', 'all', 'codex', 'claude_code', 'gemini_cli', 'cursor', 'copilot', 'cline', 'windsurf', 'roo', 'openhands', 'aider', 'mcp_client'],
        },
        kind: {
          type: 'string',
          description: 'Optional asset kind filter, e.g. skill, prompt, knowledge, mcp_config, script',
        },
        policy: {
          type: 'string',
          description: 'Optional Codex install policy filter.',
          enum: ['allow', 'confirm', 'stage_only', 'deny'],
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'tokrepo_detail',
    description: 'Get full details of a TokRepo asset by UUID, including description, content, tags, install instructions, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Asset UUID (from search results)',
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tokrepo_install',
    description: 'Get the install command and raw content for a TokRepo asset. Returns the content ready to be saved to a file or executed.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Asset UUID',
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tokrepo_install_plan',
    description: 'STEP 1 of ATOMIC ACTION 2 (install safely into this repo). Returns an agent-native install plan v2 for a TokRepo asset: preconditions, actions, risk profile, policy decision, rollback, post-install verification, evidence_bundle, SBOM-lite, signature_evidence, and provenance_v2. MUST be called before tokrepo_verify → tokrepo_codex_install. If something fails downstream, use tokrepo_rollback as the escape.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Asset UUID, workflow URL slug, or workflow UUID from search/detail results',
        },
        target: {
          type: 'string',
          description: 'Install target adapter. Codex is native; other adapters may return planned or staged contracts as they become available.',
          enum: ['codex', 'claude_code', 'gemini_cli'],
          default: 'codex',
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tokrepo_verify',
    description: 'STEP 2 of ATOMIC ACTION 2 (install safely into this repo). Read-only asset trust verification. Produces content hash, install plan hash, policy decision, permission envelope, trust_score_v2, evidence_bundle, SBOM-lite, signature_evidence, blockers, warnings, schemas, and safe next actions before activation. Call AFTER tokrepo_install_plan, BEFORE tokrepo_codex_install.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Asset UUID, workflow URL slug, or workflow UUID from search/detail results. Ignored when offline=true.',
        },
        target: {
          type: 'string',
          description: 'Verification target adapter.',
          enum: ['codex'],
          default: 'codex',
        },
        strict: {
          type: 'boolean',
          description: 'When true, warnings fail the verification report.',
          default: false,
        },
        offline: {
          type: 'boolean',
          description: 'Use the bundled offline fixture. Intended for agent/toolchain self-tests.',
          default: false,
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tokrepo_codex_install',
    description: 'STEP 3 of ATOMIC ACTION 2 (install safely into this repo). Safely install a TokRepo asset into local Codex. Defaults to dry_run=true. To write files, set dry_run=false and confirm=true. Risky assets require stage=true or approve_risk=true. Always call tokrepo_install_plan + tokrepo_verify first. On any failure call tokrepo_rollback (STEP 4 — the escape).',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Asset UUID, workflow URL, or search term accepted by the TokRepo CLI',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, return the plan only and do not write files. Default true.',
          default: true,
        },
        stage: {
          type: 'boolean',
          description: 'Write only a staged install plan under ~/.codex/tokrepo/staged instead of activating a skill.',
          default: false,
        },
        confirm: {
          type: 'boolean',
          description: 'Required when dry_run=false to prevent accidental writes.',
          default: false,
        },
        approve_risk: {
          type: 'boolean',
          description: 'Required to activate assets whose policy decision is confirm or stage_only. Prefer stage=true for high-risk assets.',
          default: false,
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tokrepo_clone_plan',
    description: 'Plan a bulk Codex install from a TokRepo user profile using the TokRepo CLI. Returns JSON dry-run output without writing files.',
    inputSchema: {
      type: 'object',
      properties: {
        user: {
          type: 'string',
          description: 'TokRepo username such as @henuwangkai or @me',
        },
        keyword: {
          type: 'string',
          description: 'Optional keyword filter, e.g. video',
        },
        types: {
          type: 'string',
          description: 'Optional comma-separated asset kinds, e.g. skill,prompt,knowledge',
        },
      },
      required: ['user'],
    },
  },
  {
    name: 'tokrepo_installed',
    description: 'List Codex assets installed by TokRepo from the local install manifest, including file status and session ids.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'tokrepo_update',
    description: 'Check or update TokRepo-managed Codex assets from the local manifest. Defaults to dry_run=true. To write updates, set dry_run=false and confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'When true, check for updates and return the plan without writing files. Default true.',
          default: true,
        },
        confirm: {
          type: 'boolean',
          description: 'Required when dry_run=false to prevent accidental writes.',
          default: false,
        },
        stage: {
          type: 'boolean',
          description: 'Stage risky updates under ~/.codex/tokrepo/staged instead of activating them.',
          default: false,
        },
        approve_risk: {
          type: 'boolean',
          description: 'Allow updates whose install policy requires explicit risk approval.',
          default: false,
        },
      },
    },
  },
  {
    name: 'tokrepo_uninstall',
    description: 'Safely uninstall a TokRepo-managed Codex asset. Defaults to dry_run=true. To remove files, set dry_run=false and confirm=true. Local changes are blocked unless force=true.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Installed asset UUID, UUID prefix, or title.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, return the removal plan without deleting files. Default true.',
          default: true,
        },
        confirm: {
          type: 'boolean',
          description: 'Required when dry_run=false to prevent accidental deletes.',
          default: false,
        },
        force: {
          type: 'boolean',
          description: 'Allow removal when local files changed since installation.',
          default: false,
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'tokrepo_rollback',
    description: 'STEP 4 of ATOMIC ACTION 2 (install safely into this repo) — the escape. Roll back a previous TokRepo Codex install session when verify/apply fails or the user rejects the result. Defaults to dry_run=true and last=true. The four-step install atomic action (plan → verify → apply → rollback) is contractually incomplete without this escape.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to roll back. Omit when last=true.',
        },
        last: {
          type: 'boolean',
          description: 'Use the latest install/stage session. Default true.',
          default: true,
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, return the rollback plan without deleting files. Default true.',
          default: true,
        },
        confirm: {
          type: 'boolean',
          description: 'Required when dry_run=false to prevent accidental deletes.',
          default: false,
        },
        force: {
          type: 'boolean',
          description: 'Allow rollback when local files changed since installation.',
          default: false,
        },
      },
    },
  },
  {
    name: 'tokrepo_handoff_plan',
    description: 'Inspect local files after a task and return an agent handoff packaging plan with quality_gate, package_manifest, SBOM-lite, and provenance. This is read-only and never publishes automatically; use tokrepo_push only after human confirmation with explicit reviewed files.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Optional explicit local paths to inspect. Omit to scan common reusable agent asset files in the current project.',
          items: { type: 'string' },
        },
        limit: {
          type: 'number',
          description: 'Max candidates to return (default 12, max 30).',
          default: 12,
        },
      },
    },
  },
  {
    name: 'tokrepo_harvest',
    description: 'ATOMIC ACTION 3 of 3 (harvest what this agent just created). Call at the END of every task that produced reusable artifacts. Inspects changed or explicit local files and produces private-by-default reusable asset package drafts with metadata, usage examples, risk notes, compatibility, and quality gates. Never publishes automatically — `tokrepo_push` is a separate user-gated call. Skipping harvest leaves valuable per-session work stranded; this is how the agent contributes back to the find pool.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Optional explicit local paths to inspect. Omit to scan common reusable agent asset files.',
          items: { type: 'string' },
        },
        changed: {
          type: 'boolean',
          description: 'When true, inspect git-changed files from the current repository.',
          default: false,
        },
        limit: {
          type: 'number',
          description: 'Max drafts to return (default 12, max 30).',
          default: 12,
        },
      },
    },
  },
  {
    name: 'tokrepo_eval_agent',
    description: 'Run TokRepo agent-native evals through the CLI. Verifies filtered search, install-plan contracts, metadata quality reporting, Codex install verification, manifest state, and rollback using temporary local state.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Optional sample asset UUID for install-plan and lifecycle tests.',
        },
        keyword: {
          type: 'string',
          description: 'Optional search keyword for filtered search eval. Default video.',
        },
      },
    },
  },
  {
    name: 'tokrepo_trending',
    description: 'Get trending/popular AI assets on TokRepo. Use when user asks for recommended or popular AI tools.',
    inputSchema: {
      type: 'object',
      properties: {
        sort: {
          type: 'string',
          description: 'Sort order',
          enum: ['popular', 'latest', 'views', 'stars'],
          default: 'popular',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'tokrepo_edges',
    description: 'Read the asset relationship graph for one asset. Returns inbound + outbound edges across requires (hard deps), extends (soft pairings), and co_used (behavior-derived co-installs). Use this BEFORE planning installs to discover related assets and avoid solo installs of assets that pair with others.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Asset UUID. Either uuid or slug is required.',
        },
        slug: {
          type: 'string',
          description: 'Asset slug. Either uuid or slug is required.',
        },
        direction: {
          type: 'string',
          enum: ['out', 'in', 'both'],
          description: 'out = this asset → other assets (deps); in = other assets → this asset (depended-on); both (default).',
          default: 'both',
        },
        types: {
          type: 'string',
          description: 'Optional comma-separated edge_type filter, e.g. "requires,co_used". Omit for all types.',
        },
      },
    },
  },
  {
    name: 'tokrepo_push',
    description: 'Push ONE specific asset to TokRepo. You choose exactly which files to include — nothing is uploaded automatically. Set visibility=0 for private (only you can see) or visibility=1 for public. IMPORTANT: Always confirm with the user before pushing, and never push files that may contain secrets, credentials, or personal data. Requires TOKREPO_TOKEN env var.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Asset title (descriptive name for this specific asset)',
        },
        files: {
          type: 'array',
          description: 'Only the specific files for THIS asset — not all project files. Each file you list will be uploaded.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name (e.g. "rules.md")' },
              content: { type: 'string', description: 'File content — review for secrets before including' },
              type: { type: 'string', description: 'File type: skill, prompt, script, config, other', default: 'other' },
            },
            required: ['name', 'content'],
          },
        },
        description: { type: 'string', description: 'Optional description' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags (e.g. ["coding", "agent"])',
        },
        visibility: {
          type: 'number',
          description: '0 = private (only visible to you, safe default for personal assets), 1 = public (visible to everyone). When unsure, default to 0 (private).',
          default: 0,
        },
      },
      required: ['title', 'files'],
    },
  },
  {
    name: 'tokrepo_status',
    description: 'Compare local files against remote TokRepo assets. Returns new/updated/unchanged status for each asset. Like "git status". Requires TOKREPO_TOKEN env var.',
    inputSchema: {
      type: 'object',
      properties: {
        assets: {
          type: 'array',
          description: 'Assets to compare',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Asset title to match against remote' },
              files: {
                type: 'array',
                description: 'Files in this asset (used to compute content hash)',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    content: { type: 'string' },
                  },
                  required: ['name', 'content'],
                },
              },
            },
            required: ['title', 'files'],
          },
        },
      },
      required: ['assets'],
    },
  },
  {
    name: 'tokrepo_list_my',
    description: 'List all assets owned by the authenticated user. Requires TOKREPO_TOKEN env var.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number (default 1)', default: 1 },
        limit: { type: 'number', description: 'Results per page (default 20, max 50)', default: 20 },
      },
    },
  },
];

const EXPOSED_TOOL_NAMES = new Set([
  'tokrepo_session_init',
  'tokrepo_find_for_task',
  'tokrepo_discover',
  'tokrepo_resolve_capability',
  'tokrepo_search',
  'tokrepo_detail',
  'tokrepo_install_plan',
  'tokrepo_verify',
  'tokrepo_codex_install',
  'tokrepo_installed',
  'tokrepo_update',
  'tokrepo_uninstall',
  'tokrepo_rollback',
  'tokrepo_handoff_plan',
  'tokrepo_harvest',
  'tokrepo_edges',
  'tokrepo_push',
]);

const TOOL_ANNOTATIONS = {
  tokrepo_session_init: {
    title: 'Bootstrap the session capability inventory (call FIRST, once)',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_find_for_task: {
    title: 'Find an asset for a task — atomic action 1 of 3 (find/install/harvest)',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_discover: {
    title: 'Discover reusable AI assets before inventing a one-off tool',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_resolve_capability: {
    title: 'Resolve a capability gap into a verified asset and install plan',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_search: {
    title: 'Search reusable AI assets',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_detail: {
    title: 'Read asset details and metadata',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_edges: {
    title: 'Walk the asset relationship graph (requires / extends / co_used)',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_install_plan: {
    title: 'Plan an install before any file write',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_verify: {
    title: 'Verify asset trust, hashes, permissions, and policy before activation',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  tokrepo_codex_install: {
    title: 'Dry-run, stage, or install an asset for Codex',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  tokrepo_installed: {
    title: 'List locally installed TokRepo assets',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tokrepo_update: {
    title: 'Dry-run or update installed TokRepo assets',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  tokrepo_uninstall: {
    title: 'Dry-run or uninstall a TokRepo-managed asset',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tokrepo_rollback: {
    title: 'Dry-run or roll back a TokRepo install session',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tokrepo_handoff_plan: {
    title: 'Plan post-task handoff of reusable local work',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tokrepo_harvest: {
    title: 'Harvest reusable local work into private-by-default package drafts',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tokrepo_push: {
    title: 'Publish explicit reviewed files to TokRepo after confirmation',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const EXPOSED_TOOLS = TOOLS
  .filter((tool) => EXPOSED_TOOL_NAMES.has(tool.name))
  .map((tool) => ({
    ...tool,
    annotations: TOOL_ANNOTATIONS[tool.name],
  }));

// ─── HTTP Helper ───

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${path}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data);
        } catch (e) {
          reject(new Error(`Invalid JSON from ${path}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function apiGetText(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const req = https.get(url, { headers: { Accept: 'text/plain' }, timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${path}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function apiPost(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Authorization': `Bearer ${token}`,
        'User-Agent': `tokrepo-mcp-server/${SERVER_VERSION}`,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from ${urlPath}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

function telemetryDisabled() {
  const value = String(process.env.TOKREPO_TELEMETRY || '').toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(value);
}

function eventForTool(name, args = {}) {
  if (name === 'tokrepo_find_for_task') return 'find_for_task';
  if (name === 'tokrepo_discover') return 'mcp_discover';
  if (name === 'tokrepo_resolve_capability') return 'capability_resolve';
  if (name === 'tokrepo_search') return 'mcp_search';
  if (name === 'tokrepo_detail') return 'mcp_detail';
  if (name === 'tokrepo_edges') return 'mcp_search';
  if (name === 'tokrepo_install_plan') return 'install_plan';
  if (name === 'tokrepo_verify') return 'verify_asset';
  if (name === 'tokrepo_codex_install') return args.dry_run === false ? 'install_apply' : 'install_dry_run';
  if (name === 'tokrepo_rollback') return 'rollback_plan';
  if (name === 'tokrepo_handoff_plan') return 'handoff_plan';
  if (name === 'tokrepo_harvest') return 'harvest_plan';
  if (name === 'tokrepo_push') return 'push';
  return '';
}

function candidateCountFromResult(result) {
  const text = result?.content?.map(item => item.text || '').join('\n') || '';
  return (text.match(/"uuid"\s*:/g) || []).length;
}

function trackAgentEventForTool(name, args = {}, result = {}) {
  if (telemetryDisabled()) return;
  const event = eventForTool(name, args);
  if (!event) return;
  try {
    const url = new URL('/api/v1/tokenboard/agent/events', API_BASE);
    if (url.protocol === 'http:' && !url.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
      url.protocol = 'https:';
    }
    const body = JSON.stringify({
      event,
      source: 'mcp',
      version: SERVER_VERSION,
      target: args.target || args?.constraints?.target || 'any',
      kind: args.kind || args?.constraints?.kind || '',
      policy: args.policy || args?.constraints?.policy || '',
      result: result?.isError ? 'error' : 'pass',
      dry_run: name === 'tokrepo_codex_install' ? args.dry_run !== false : undefined,
      candidate_count: candidateCountFromResult(result),
    });
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': `tokrepo-mcp-server/${SERVER_VERSION}`,
      },
      timeout: 700,
    }, (res) => {
      res.resume();
    });
    req.on('socket', socket => socket.unref?.());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch {
    // Telemetry is best-effort only.
  }
}

function apiGetAuth(urlPath, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const req = https.get({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': `tokrepo-mcp-server/${SERVER_VERSION}`,
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`Invalid JSON`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function requireToken() {
  if (!TOKREPO_TOKEN) {
    throw new Error('TOKREPO_TOKEN environment variable is required for write operations. Get your token at https://tokrepo.com/en/my/settings');
  }
  return TOKREPO_TOKEN;
}

function workflowIdentifier(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/workflows\/([^/?#]+)/);
  const value = match ? match[1] : raw;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    return { param: 'uuid', value };
  }
  return { param: 'slug', value };
}

async function fetchInstallPlan(input, target = 'codex') {
  const id = workflowIdentifier(input);
  const params = new URLSearchParams({ target });
  params.set(id.param, id.value);
  let res = await apiGet(`/api/v1/tokenboard/workflows/install-plan?${params}`);
  if (res.code === 200 && res.data?.plan) return res.data.plan;

  if (id.param === 'slug') {
    const search = await apiGet(`/api/v1/tokenboard/workflows/list?keyword=${encodeURIComponent(id.value.replace(/[-_.]/g, ' '))}&page=1&page_size=1&sort_by=views`);
    const uuid = search.data?.list?.[0]?.uuid;
    if (uuid) {
      res = await apiGet(`/api/v1/tokenboard/workflows/install-plan?uuid=${encodeURIComponent(uuid)}&target=${encodeURIComponent(target)}`);
      if (res.code === 200 && res.data?.plan) return res.data.plan;
    }
  }

  throw new Error(res.message || `Install plan not found for ${input}`);
}

function planPolicyDecision(plan) {
  const policy = plan?.policy_decision || plan?.policyDecision || {};
  return String(policy.decision || 'confirm');
}

function runTokrepoCli(args) {
  const command = TOKREPO_CLI || 'npx';
  const finalArgs = TOKREPO_CLI ? args : ['-y', 'tokrepo@latest', ...args];
  return new Promise((resolve, reject) => {
    execFile(command, finalArgs, {
      env: { ...process.env, TOKREPO_NONINTERACTIVE: '1' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120000,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function jsonText(title, data) {
  return `${title}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function compactText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizeTarget(value) {
  const raw = compactText(value || 'any', 64).toLowerCase().replace(/[-\s]+/g, '_');
  const aliases = {
    claude: 'claude_code',
    claude_code: 'claude_code',
    gemini: 'gemini_cli',
    gemini_cli: 'gemini_cli',
    codex: 'codex',
    cursor: 'cursor',
    windsurf: 'windsurf',
    mcp: 'mcp_client',
    mcp_client: 'mcp_client',
    any: 'any',
    all: 'any',
  };
  return aliases[raw] || raw || 'any';
}

function itemTags(item) {
  return asArray(item.tags).map(tag => compactText(tag.name || tag.slug || tag, 64)).filter(Boolean);
}

function itemAgentMetadata(item) {
  return item.agent_metadata || item.agentMetadata || item.metadata?.agent_metadata || {};
}

function itemAgentFit(item) {
  return item.agent_fit || item.agentFit || item.fit || {};
}

function candidateUuid(item) {
  return compactText(item.uuid || item.workflow_uuid || item.workflowUuid || item.id, 128);
}

function candidateKind(item, metadata, fit) {
  return compactText(item.asset_kind || item.assetKind || metadata.asset_kind || fit.asset_kind || '', 64);
}

function candidateTargets(item, metadata) {
  const targets = [
    ...asArray(item.target_tools || item.targetTools),
    ...asArray(metadata.target_tools || metadata.targetTools),
  ].map(target => compactText(target, 64)).filter(Boolean);
  return [...new Set(targets)];
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function normalizedObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function itemRiskProfile(item, metadata) {
  const risk = normalizedObject(firstPresent(
    item.risk_profile,
    item.riskProfile,
    metadata.risk_profile,
    metadata.riskProfile,
  ));
  return {
    executes_code: Boolean(risk.executes_code ?? risk.executesCode),
    modifies_global_config: Boolean(risk.modifies_global_config ?? risk.modifiesGlobalConfig),
    requires_secrets: asArray(risk.requires_secrets || risk.requiresSecrets).map(secret => compactText(secret, 96)),
    uses_absolute_paths: Boolean(risk.uses_absolute_paths ?? risk.usesAbsolutePaths),
    network_access: Boolean(risk.network_access ?? risk.networkAccess),
  };
}

function itemDependencies(item, metadata) {
  const deps = normalizedObject(firstPresent(item.dependencies, metadata.dependencies));
  return {
    npm: asArray(deps.npm).map(dep => compactText(dep, 96)),
    pip: asArray(deps.pip).map(dep => compactText(dep, 96)),
    brew: asArray(deps.brew).map(dep => compactText(dep, 96)),
    system: asArray(deps.system).map(dep => compactText(dep, 96)),
  };
}

function itemVerification(item, metadata, plan = {}) {
  const verification = normalizedObject(firstPresent(
    item.verification,
    metadata.verification,
    plan.verification,
  ));
  return {
    commands: asArray(verification.commands).map(command => compactText(command, 240)),
    expected_files: [
      ...asArray(verification.expected_files || verification.expectedFiles),
      ...asArray(plan.post_verify || plan.postVerify).map(check => check?.path).filter(Boolean),
    ].map(file => compactText(file, 240)),
  };
}

function hasDeclaredRisk(item, metadata) {
  return Boolean(item.risk_profile || item.riskProfile || metadata.risk_profile || metadata.riskProfile);
}

function hasAnyRisk(risk) {
  return Boolean(
    risk.executes_code ||
    risk.modifies_global_config ||
    risk.requires_secrets?.length ||
    risk.uses_absolute_paths ||
    risk.network_access
  );
}

function agentEndpointUrls(displayId, target = 'codex', apiId = displayId) {
  const encodedDisplay = encodeURIComponent(displayId || '');
  const encodedApi = encodeURIComponent(apiId || displayId || '');
  return {
    human: displayId ? `${TOKREPO_URL}/en/workflows/${encodedDisplay}` : '',
    raw: displayId ? `${TOKREPO_URL}/raw/${encodedDisplay}` : '',
    metadata: displayId ? `${TOKREPO_URL}/metadata/${encodedDisplay}.json` : '',
    install_plan: encodedApi ? `${API_BASE}/api/v1/tokenboard/workflows/install-plan?uuid=${encodedApi}&target=${encodeURIComponent(target)}` : '',
    detail_api: encodedApi ? `${API_BASE}/api/v1/tokenboard/workflows/detail?uuid=${encodedApi}` : '',
  };
}

function readinessComponent(name, score, max, evidence = [], status = '') {
  const finalScore = Math.max(0, Math.min(max, Math.round(score)));
  return {
    name,
    score: finalScore,
    max,
    status: status || (finalScore >= max ? 'pass' : finalScore > 0 ? 'warn' : 'block'),
    evidence: asArray(evidence).map(item => compactText(item, 180)).filter(Boolean),
  };
}

function buildAgentReadiness(input) {
  const item = input.item || {};
  const metadata = input.metadata || itemAgentMetadata(item);
  const fit = input.fit || itemAgentFit(item);
  const plan = input.plan || {};
  const trust = normalizedObject(input.trust || item.trust || item.agent_trust || item.agentTrust);
  const id = candidateUuid(item) || compactText(plan.asset_uuid || plan.assetUuid || input.id, 128);
  const title = compactText(item.title || plan.asset_title || plan.assetTitle || '', 160);
  const kind = candidateKind(item, metadata, fit) || compactText(plan.metadata?.asset_kind || plan.metadata?.assetKind || '', 64);
  const targets = candidateTargets(item, metadata);
  const installMode = compactText(firstPresent(
    item.install_mode,
    item.installMode,
    metadata.install_mode,
    metadata.installMode,
    fit.install_mode,
    fit.installMode,
    plan.install_mode,
    plan.installMode,
  ), 64);
  const entrypoint = compactText(firstPresent(
    item.entrypoint,
    metadata.entrypoint,
    plan.entrypoint,
  ), 160);
  const policy = compactText(firstPresent(
    fit.policy,
    item.policy,
    plan.policy_decision?.decision,
    plan.policyDecision?.decision,
  ), 64);
  const contentHash = compactText(firstPresent(
    item.content_hash,
    item.contentHash,
    metadata.content_hash,
    metadata.contentHash,
    plan.metadata?.content_hash,
    plan.metadata?.contentHash,
  ), 128);
  const updatedAt = compactText(firstPresent(item.updated_at, item.updatedAt, plan.updated_at, plan.updatedAt), 64);
  const version = compactText(firstPresent(item.version, metadata.version, plan.version), 64);
  const risk = itemRiskProfile(item, metadata);
  const verification = itemVerification(item, metadata, plan);
  const hasPlan = Boolean(input.has_plan || plan.asset_uuid || plan.assetUuid || plan.actions?.length);

  const components = [
    readinessComponent('discoverable', id && title && kind ? 20 : id && title ? 14 : id ? 8 : 0, 20, [
      id && `id:${id}`,
      title && 'title',
      kind && `asset_kind:${kind}`,
    ]),
    readinessComponent('readable', (entrypoint ? 8 : 0) + (contentHash ? 7 : 0), 15, [
      entrypoint && `entrypoint:${entrypoint}`,
      contentHash && 'content_hash',
    ]),
    readinessComponent('installable', (installMode ? 10 : 0) + (hasPlan ? 10 : 0), 20, [
      installMode && `install_mode:${installMode}`,
      hasPlan && 'install_plan',
    ]),
    readinessComponent('safe', policy === 'deny' ? 0 : (hasDeclaredRisk(item, metadata) ? 10 : 5) + (hasAnyRisk(risk) ? 5 : 10), 20, [
      policy && `policy:${policy}`,
      hasDeclaredRisk(item, metadata) ? 'risk_profile_declared' : 'risk_profile_inferred_or_missing',
      hasAnyRisk(risk) ? 'risk_non_empty' : 'markdown_or_low_risk',
      trust.score != null && `trust:${trust.score}`,
    ], policy === 'deny' ? 'block' : ''),
    readinessComponent('executable', verification.commands.length || verification.expected_files.length ? 15 : 0, 15, [
      verification.commands.length && `${verification.commands.length} verify command(s)`,
      verification.expected_files.length && `${verification.expected_files.length} expected file(s)`,
    ]),
    readinessComponent('maintained', (contentHash ? 5 : 0) + (updatedAt || version ? 5 : 0), 10, [
      updatedAt && `updated:${updatedAt}`,
      version && `version:${version}`,
    ]),
  ];
  const score = components.reduce((sum, component) => sum + component.score, 0);
  const blockers = [];
  if (policy === 'deny') blockers.push('policy_denied');
  if (!id) blockers.push('missing_stable_id');
  if (!installMode) blockers.push('missing_install_mode');
  const status = blockers.length
    ? 'blocked'
    : policy === 'stage_only'
      ? 'stage_only'
      : score >= 80
        ? 'ready'
        : score >= 60
          ? 'review'
          : 'incomplete';
  return {
    schema_version: 1,
    score,
    status,
    policy: policy || 'unknown',
    target_tools: targets,
    components,
    blockers,
    next_action: status === 'ready'
      ? 'call tokrepo_install_plan, then tokrepo_verify before any write'
      : 'inspect detail, missing metadata, policy, and verification before install',
  };
}

function buildAgentAssetContract(item, target = 'codex', options = {}) {
  const metadata = options.metadata || itemAgentMetadata(item);
  const fit = options.fit || itemAgentFit(item);
  const plan = options.plan || {};
  const id = candidateUuid(item) || compactText(plan.asset_uuid || plan.assetUuid || options.id, 128);
  const slug = compactText(item.slug || item.url_slug || item.urlSlug || '', 180);
  const urlId = slug || id;
  const endpoints = agentEndpointUrls(urlId || id, target, id || urlId);
  const risk = itemRiskProfile(item, metadata);
  const verification = itemVerification(item, metadata, plan);
  const readiness = buildAgentReadiness({ item, metadata, fit, plan, trust: options.trust, has_plan: options.has_plan });
  const installMode = compactText(firstPresent(
    item.install_mode,
    item.installMode,
    metadata.install_mode,
    metadata.installMode,
    fit.install_mode,
    fit.installMode,
    plan.install_mode,
    plan.installMode,
  ), 64);
  const entrypoint = compactText(firstPresent(item.entrypoint, metadata.entrypoint, plan.entrypoint), 160);
  return {
    schema_version: 1,
    id,
    slug,
    title: compactText(item.title || plan.asset_title || plan.assetTitle || '', 160),
    description: compactText(item.description || item.summary || '', 320),
    asset_kind: candidateKind(item, metadata, fit) || compactText(plan.metadata?.asset_kind || plan.metadata?.assetKind || '', 64),
    target_tools: candidateTargets(item, metadata),
    source: {
      url: endpoints.human,
      raw_url: endpoints.raw,
      metadata_url: endpoints.metadata,
      detail_api: endpoints.detail_api,
      content_hash: compactText(firstPresent(item.content_hash, item.contentHash, metadata.content_hash, metadata.contentHash, plan.metadata?.content_hash, plan.metadata?.contentHash), 128),
      version: compactText(firstPresent(item.version, metadata.version, plan.version), 64),
      updated_at: compactText(firstPresent(item.updated_at, item.updatedAt, plan.updated_at, plan.updatedAt), 64),
    },
    capability: {
      entrypoint,
      install_mode: installMode,
      policy: compactText(firstPresent(fit.policy, item.policy, plan.policy_decision?.decision, plan.policyDecision?.decision), 64),
      agent_fit: fit,
    },
    risk,
    dependencies: itemDependencies(item, metadata),
    verification,
    readiness,
    lifecycle: {
      inspect: { tool: 'tokrepo_detail', arguments: { uuid: id } },
      verify: { tool: 'tokrepo_verify', arguments: { uuid: id, target } },
      plan: { tool: 'tokrepo_install_plan', arguments: { uuid: id, target } },
      dry_run_install: id ? `tokrepo install ${id} --target ${target} --dry-run --json` : '',
      rollback: 'tokrepo_rollback after any failed write or activation',
    },
    install_plan_url: endpoints.install_plan,
  };
}

function extractSearchTerms(value, maxTerms = 8) {
  const text = compactText(value, 240);
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'how',
    'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'the', 'this',
    'to', 'use', 'with', 'fix', 'make', 'need', 'needs', 'want', 'issue', 'issues',
  ]);
  const words = text
    .split(/[^a-zA-Z0-9+#.]+/)
    .map(word => word.trim().toLowerCase())
    .filter(word => word.length >= 2 && !stopWords.has(word));
  const unique = [...new Set(words)].slice(0, maxTerms);
  return unique.length ? unique : [compactText(text, 80)];
}

function buildDiscoveryQuery(task, environment, constraints) {
  const parts = extractSearchTerms(task, 6);
  for (const key of ['project_type', 'language', 'framework', 'domain']) {
    if (environment?.[key]) parts.push(...extractSearchTerms(environment[key], 2));
  }
  for (const value of asArray(environment?.frameworks)) parts.push(...extractSearchTerms(value, 2));
  if (constraints?.kind) parts.push(...extractSearchTerms(constraints.kind, 2));
  return compactText([...new Set(parts)].join(' '), 100);
}

function inferAgentCapabilityAnalysis(task, target = 'any', constraints = {}, environment = {}) {
  const text = [
    task,
    constraints.kind,
    constraints.policy,
    environment.project_type,
    environment.language,
    ...asArray(environment.frameworks),
  ].filter(Boolean).join(' ').toLowerCase();
  const normalizeKind = (value) => String(value || '').toLowerCase().replace(/[-\s]+/g, '_');
  const rules = [
    {
      name: 'domain_or_workflow_skill',
      kind: 'skill',
      evidence: ['skill', 'rule', 'guideline', 'review', 'audit', 'seo', 'design', 'frontend', 'backend', 'security', 'test', 'deploy', 'video', 'writing'],
      why: 'The task likely benefits from reusable instructions, domain rules, or a repeatable agent workflow.',
    },
    {
      name: 'agent_tool_or_mcp_integration',
      kind: 'mcp_config',
      evidence: ['mcp', 'tool', 'api', 'integration', 'github', 'browser', 'calendar', 'email', 'gmail', 'slack', 'notion', 'database', 'vercel'],
      why: 'The task may require a callable tool surface instead of hand-written one-off glue code.',
    },
    {
      name: 'automation_script',
      kind: 'script',
      evidence: ['script', 'cli', 'batch', 'cron', 'automation', 'generate', 'convert', 'migrate', 'lint', 'check'],
      why: 'The task may reuse a tested script or command wrapper.',
    },
    {
      name: 'prompt_or_reasoning_template',
      kind: 'prompt',
      evidence: ['prompt', 'copy', 'research', 'analysis', 'summarize', 'translate', 'plan', 'brainstorm'],
      why: 'The task may reuse a prompt template or reasoning checklist.',
    },
    {
      name: 'knowledge_or_policy_pack',
      kind: 'knowledge',
      evidence: ['policy', 'standard', 'compliance', 'docs', 'documentation', 'architecture', 'best practice', 'trust'],
      why: 'The task may need reusable reference knowledge or policy constraints.',
    },
  ];
  const inferred = [];
  for (const rule of rules) {
    const matches = rule.evidence.filter(term => text.includes(term));
    if (constraints.kind && normalizeKind(constraints.kind) === normalizeKind(rule.kind)) matches.push(`requested kind ${rule.kind}`);
    if (!matches.length) continue;
    inferred.push({
      name: rule.name,
      asset_kind: rule.kind,
      confidence: Math.min(0.95, 0.55 + matches.length * 0.08),
      evidence: Array.from(new Set(matches)).slice(0, 6),
      why: rule.why,
    });
  }
  if (!inferred.length) {
    inferred.push({
      name: 'general_reusable_agent_capability',
      asset_kind: constraints.kind || 'skill',
      confidence: 0.5,
      evidence: ['new task capability gap'],
      why: 'Before creating local one-off work, the agent should check whether TokRepo already has a reusable asset.',
    });
  }
  const preferredAssetKinds = Array.from(new Set([
    constraints.kind,
    ...inferred.map(item => item.asset_kind),
    'skill',
    'prompt',
    'mcp_config',
    'script',
    'workflow',
    'knowledge',
  ].filter(Boolean))).slice(0, 6);
  const taskTerms = extractSearchTerms(task, 6);
  return {
    schema_version: 1,
    decision: 'discover_before_build',
    target,
    trigger: 'planning_time_capability_gap',
    inferred_capabilities: inferred,
    preferred_asset_kinds: preferredAssetKinds,
    search_queries: Array.from(new Set([
      buildDiscoveryQuery(task, environment, constraints),
      compactText(taskTerms.slice(0, 4).join(' '), 100),
      ...preferredAssetKinds.map(kind => compactText(`${taskTerms.slice(0, 3).join(' ')} ${kind}`, 100)),
    ].filter(Boolean))).slice(0, 6),
    required_mcp_sequence: [
      'tokrepo_discover',
      'tokrepo_detail',
      'tokrepo_verify',
      'tokrepo_install_plan',
    ],
    acceptance_criteria: [
      'Do not require the human to browse the TokRepo GUI before discovery.',
      'Use a candidate only when fit, policy, trust, and permission envelope match the active subtask.',
      'Prefer dry-run or stage-only before writes, execution, secrets, network access, or global config changes.',
      'After completing the task, run tokrepo agent-handoff --json to preserve reusable improvements.',
    ],
    empty_state_strategy: [
      'Try broader capability terms from search_queries.',
      'If still empty, build locally and package the reusable part with tokrepo agent-handoff.',
    ],
  };
}

function scoreDiscoveryCandidate(item, task, target, constraints = {}) {
  const metadata = itemAgentMetadata(item);
  const fit = itemAgentFit(item);
  const tags = itemTags(item);
  const targets = candidateTargets(item, metadata);
  const terms = extractSearchTerms(task, 10);
  const haystack = [
    item.title,
    item.description,
    tags.join(' '),
    metadata.entrypoint,
    metadata.asset_kind,
  ].filter(Boolean).join(' ').toLowerCase();
  let score = Number.isFinite(Number(fit.score)) ? Number(fit.score) : 45;
  const reasons = [];
  const matched = terms.filter(term => haystack.includes(term));
  if (matched.length) {
    score += Math.min(24, matched.length * 4);
    reasons.push(`task term match: ${matched.slice(0, 5).join(', ')}`);
  }
  if (target && target !== 'any') {
    if (targets.includes(target) || fit.target === target) {
      score += 12;
      reasons.push(`target matches ${target}`);
    } else if (targets.length) {
      score -= 10;
      reasons.push(`target metadata is ${targets.join(', ')}`);
    }
  }
  const kind = candidateKind(item, metadata, fit);
  if (constraints.kind && String(kind).toLowerCase() === String(constraints.kind).toLowerCase()) {
    score += 8;
    reasons.push(`kind matches ${constraints.kind}`);
  }
  const policy = fit.policy || item.policy || '';
  if (policy === 'allow') {
    score += 6;
    reasons.push('policy allow');
  } else if (policy === 'deny') {
    score -= 35;
    reasons.push('policy deny');
  } else if (policy === 'stage_only' || policy === 'confirm') {
    score -= 6;
    reasons.push(`policy ${policy}`);
  }
  const trust = item.trust || item.agent_trust || {};
  if (trust.review_status === 'reviewed' || trust.verified_publisher) {
    score += 4;
    reasons.push('reviewed or verified');
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

function buildCandidate(item, target, ranking = {}) {
  const uuid = candidateUuid(item);
  const metadata = itemAgentMetadata(item);
  const fit = itemAgentFit(item);
  const kind = candidateKind(item, metadata, fit);
  const targets = candidateTargets(item, metadata);
  const planTarget = target && target !== 'any' && ['codex', 'claude_code', 'gemini_cli'].includes(target)
    ? target
    : 'codex';
  const urlSlug = compactText(item.slug || uuid, 180);
  const score = Number.isFinite(Number(fit.score)) ? Number(fit.score) : null;
  const why = asArray(fit.why).map(reason => compactText(reason, 160)).filter(Boolean);
  const agentAssetContract = buildAgentAssetContract(item, planTarget, {
    metadata,
    fit,
    has_plan: true,
  });

  return {
    uuid,
    slug: compactText(item.slug || '', 180),
    title: compactText(item.title, 160),
    description: compactText(item.description || item.summary || '', 320),
    url: urlSlug ? `${TOKREPO_URL}/en/workflows/${urlSlug}` : '',
    tags: itemTags(item),
    capability: {
      kind,
      install_mode: compactText(item.install_mode || item.installMode || metadata.install_mode || fit.install_mode || '', 64),
      entrypoint: compactText(item.entrypoint || metadata.entrypoint || '', 160),
      target_tools: targets,
    },
    fit: {
      target: compactText(fit.target || target || 'any', 64),
      score,
      status: compactText(fit.status || item.agent_status || '', 64),
      policy: compactText(fit.policy || item.policy || '', 64),
      why,
    },
    agent_readiness: agentAssetContract.readiness,
    agent_asset_contract: agentAssetContract,
    ranking,
    next_mcp_calls: [
      { tool: 'tokrepo_detail', arguments: { uuid } },
      { tool: 'tokrepo_verify', arguments: { uuid, target: planTarget } },
      { tool: 'tokrepo_install_plan', arguments: { uuid, target: planTarget } },
    ],
    commands: {
      inspect: `npx tokrepo detail ${uuid} --json`,
      audit: `npx tokrepo audit ${uuid} --target ${planTarget} --json`,
      verify: `npx tokrepo verify ${uuid} --target ${planTarget} --json`,
      dry_run_install: planTarget === 'codex'
        ? `npx tokrepo install ${uuid} --dry-run --json`
        : `npx tokrepo install ${uuid} --target ${planTarget} --dry-run --json`,
    },
    agent_use_contract: [
      'Use only if the capability matches the current subtask.',
      'Call tokrepo_detail before install to inspect content and metadata.',
      'Call tokrepo_verify to inspect hashes, permissions, trust_score_v2, evidence_bundle, SBOM-lite, signature_evidence, blockers, and warnings.',
      'Call tokrepo audit if future agents need a persistent trust-history snapshot.',
      'Call tokrepo_install_plan and respect policy_decision, evidence_bundle, SBOM-lite, signature_evidence, rollback, and verification steps before writing files.',
      'Prefer dry-run or stage-only when risk or fit is uncertain.',
      'After using it, verify the original task outcome and record failures.',
    ],
  };
}

// ─── Tool Handlers ───

async function fetchTrust(uuid) {
  try {
    const res = await apiGet(`/api/v1/tokenboard/trust/${encodeURIComponent(uuid)}`);
    if (res.code === 200 && res.data) return res.data;
  } catch (_) {}
  return null;
}

function trustBlock(trustData, defaults = {}) {
  if (!trustData) {
    return {
      score: null,
      decision: 'unknown',
      components: null,
      signature_status: defaults.signature_status || 'unknown',
      last_eval_date: defaults.last_eval_date || null,
      algorithm: null,
      computed_at: null,
      note: 'Trust endpoint unreachable; activation requires explicit user approval.',
    };
  }
  return {
    score: trustData.trust_score_v2,
    decision: trustData.decision || 'unknown',
    components: trustData.components || null,
    weights: trustData.weights || null,
    signature_status: defaults.signature_status || 'unverified',
    last_eval_date: trustData.computed_at || trustData.updated_at || null,
    algorithm: trustData.algorithm || null,
    computed_at: trustData.computed_at || null,
  };
}

function trustGate(trust, minTrust = MIN_TRUST) {
  if (trust?.score == null) return { gate: 'unknown', threshold: minTrust };
  return {
    gate: trust.score >= minTrust ? 'allow' : 'block',
    threshold: minTrust,
    delta: Number((trust.score - minTrust).toFixed(4)),
  };
}

async function handleSessionInit(args) {
  const projectHint = compactText(args.project_hint || '', 240);
  const target = normalizeTarget(args.target || 'any');
  const compact = args.compact !== false;
  const queries = projectHint
    ? [projectHint, projectHint.split(/\s+/).slice(0, 2).join(' ')]
    : ['agent skill', 'mcp', 'codex skill'];
  const items = [];
  for (const q of queries) {
    if (items.length >= 4) break;
    const params = new URLSearchParams({
      keyword: q,
      page: '1',
      page_size: '4',
      sort_by: 'popular',
    });
    if (target && target !== 'any') params.set('target', target);
    try {
      const res = await apiGet(`/api/v1/tokenboard/workflows/list?${params}`);
      if (res.code === 200) {
        for (const item of (res.data?.list || res.data?.items || [])) {
          if (items.find(i => i.uuid === item.uuid)) continue;
          items.push(item);
          if (items.length >= 4) break;
        }
      }
    } catch (_) {}
  }
  const inventory = items.slice(0, 4).map(item => compact ? ({
    uuid: item.uuid,
    slug: item.url_slug || item.slug || null,
    kind: item.kind || 'skill',
    title: compactText(item.title, 60),
    install: `tokrepo install ${item.uuid}`,
    url: `${TOKREPO_URL}/workflows/${item.url_slug || item.uuid}`,
  }) : ({
    uuid: item.uuid,
    title: item.title,
    summary: compactText(item.description || '', 160),
    tags: (item.tags || []).map(t => t.name || t.slug).slice(0, 4),
    install: `tokrepo install ${item.uuid}`,
  }));

  const payload = {
    schema_version: 1,
    session_id: crypto.randomBytes(8).toString('hex'),
    issued_at: new Date().toISOString(),
    target,
    project_hint: projectHint || null,
    policy_pack: {
      url: `${TOKREPO_URL}/policy-packs/default-agent-policy.json`,
    },
    trust_manifest_url: `${TOKREPO_URL}/.well-known/tokrepo-trust.json`,
    min_trust: MIN_TRUST,
    capability_inventory: inventory,
    recent_handoffs_hint: `Call tokrepo agent-handoff --json after task to surface reusable artifacts.`,
    project_memory: {
      url_doc: 'Load .tokrepo/agent.json from the current working directory if present.',
    },
    mandatory_rules: [
      '[[tokrepo.session-init-first]] this call was made — proceed to plan.',
      '[[tokrepo.discover-before-build]] before writing reusable artifacts, call tokrepo_discover.',
      '[[tokrepo.verify-before-install]] before any install, call tokrepo_verify + tokrepo_install_plan; honor trust_gate.',
      '[[tokrepo.dry-run-before-apply]] lifecycle tools must stay dry_run=true until user confirms.',
      '[[tokrepo.handoff-after-reusable]] after producing reusable artifacts, call tokrepo_handoff_plan.',
      '[[tokrepo.private-default]] tokrepo_push defaults to private; public requires explicit per-push confirmation.',
    ],
    next_call_hint: 'Call tokrepo_discover with the user task to get scored candidates.',
  };
  return {
    content: [{
      type: 'text',
      text: jsonText('TokRepo session bootstrap', payload),
    }],
  };
}

async function handleFindForTask(args) {
  const task = compactText(args.task, 500);
  if (!task) {
    return {
      content: [{ type: 'text', text: 'task is required for tokrepo_find_for_task' }],
      isError: true,
    };
  }

  const limit = clampLimit(args.limit, 3, 10);
  const body = { task, limit };
  if (args.agent && typeof args.agent === 'string') body.agent = args.agent;
  if (args.repo_context && typeof args.repo_context === 'object') body.repo_context = args.repo_context;

  let res;
  try {
    res = await apiPost('/api/v1/tokenboard/agent/find_for_task', body, '');
  } catch (e) {
    return {
      content: [{ type: 'text', text: `find_for_task failed: ${e.message}` }],
      isError: true,
    };
  }

  if (res.code !== 200) {
    return {
      content: [{ type: 'text', text: `find_for_task API code=${res.code} msg=${res.message || ''}` }],
      isError: true,
    };
  }

  const data = res.data || {};
  const candidates = data.candidates || [];
  const payload = {
    atomic_action: 'find',
    lifecycle_hint: 'After picking a candidate: tokrepo_install_plan → tokrepo_codex_install (dry_run first). After delivering the task: tokrepo_harvest.',
    task,
    task_keywords: data.task_keywords || [],
    total_searched: data.total_searched || 0,
    candidates,
    notes: data.notes || [],
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function handleDiscover(args) {
  const task = compactText(args.task, 500);
  if (!task) {
    return {
      content: [{ type: 'text', text: 'task is required for tokrepo_discover' }],
      isError: true,
    };
  }

  const environment = args.environment && typeof args.environment === 'object' ? args.environment : {};
  const constraints = args.constraints && typeof args.constraints === 'object' ? args.constraints : {};
  const target = normalizeTarget(args.target || constraints.target || 'any');
  const limit = clampLimit(args.limit, 6, 10);
  const kind = compactText(args.kind || constraints.kind || '', 64);
  const policy = compactText(args.policy || constraints.policy || '', 64);
  const query = buildDiscoveryQuery(task, environment, constraints);

  let items = [];
  let discoveryError = '';
  let selectedQuery = query;
  const taskTerms = extractSearchTerms(task, 6);
  const attempts = [
    { query, kind, policy },
    { query: taskTerms.slice(0, 3).join(' '), kind, policy },
    { query: taskTerms.slice(0, 2).join(' '), kind: '', policy: '' },
    { query: taskTerms[0] || query, kind: '', policy: '' },
  ].filter(attempt => attempt.query);
  const seenAttempts = new Set();
  const errors = [];

  for (const attempt of attempts) {
    const key = `${attempt.query}|${attempt.kind}|${attempt.policy}`;
    if (seenAttempts.has(key)) continue;
    seenAttempts.add(key);
    const params = new URLSearchParams({
      keyword: attempt.query,
      page: '1',
      page_size: String(limit),
      sort_by: 'popular',
    });
    if (target && target !== 'any') params.set('target', target);
    if (attempt.kind) params.set('kind', attempt.kind);
    if (attempt.policy) params.set('policy', attempt.policy);

    try {
      const res = await apiGet(`/api/v1/tokenboard/workflows/list?${params}`);
      items = res.code === 200 ? (res.data?.list || res.data?.items || []) : [];
      if (res.code !== 200) errors.push(compactText(res.message || `API returned code ${res.code}`, 200));
      if (items.length) {
        selectedQuery = attempt.query;
        break;
      }
    } catch (e) {
      errors.push(compactText(e.message, 200));
    }
  }
  discoveryError = errors.find(Boolean) || '';
  const payload = {
    schema_version: 1,
    intent: {
      task,
      target,
      query: selectedQuery,
      queries_tried: [...seenAttempts].map(key => key.split('|')[0]),
      environment,
      constraints,
    },
    capability_analysis: inferAgentCapabilityAnalysis(task, target, constraints, environment),
    recommended_flow: [
      'During planning, call tokrepo_discover when the task exposes a capability gap.',
      'Rank candidates by fit, policy, trust, and whether the entrypoint matches the active agent runtime.',
      'Call tokrepo_detail for the top candidate before installation or use.',
      'Call tokrepo audit if the chosen asset materially affects the task and future agents need a trust-history snapshot.',
      'Call tokrepo_install_plan and respect policy_decision, evidence_bundle, SBOM-lite, signature_evidence, rollback, and verification steps.',
      'Dry-run or stage when the asset may write files, execute code, require secrets, or change global config.',
      'Use the installed capability only for the matching subtask, then verify the user goal.',
      'If the agent creates a reusable improvement, ask before publishing and use tokrepo_push with explicit files.',
    ],
    candidates: items
      .map(item => buildCandidate(item, target, scoreDiscoveryCandidate(item, task, target, constraints)))
      .filter(candidate => candidate.uuid)
      .sort((a, b) => (b.ranking?.score || 0) - (a.ranking?.score || 0))
      .slice(0, limit),
    empty_state: items.length ? null : {
      message: discoveryError
        ? `TokRepo discovery could not fetch live candidates for "${selectedQuery}".`
        : `No TokRepo candidates found for "${selectedQuery}".`,
      error: discoveryError || undefined,
      suggested_queries: [
        task.split(/\s+/).slice(0, 4).join(' '),
        compactText([kind, environment.project_type, environment.language].filter(Boolean).join(' '), 120),
        'agent skill workflow',
      ].filter(Boolean),
    },
  };

  return {
    content: [{
      type: 'text',
      text: jsonText('TokRepo planning-time discovery', payload),
    }],
  };
}

async function handleSearch(args) {
  const { query, tag, limit = 10, target = '', kind = '', policy = '' } = args;
  const normalizedTarget = normalizeTarget(target || 'any');
  const targetFilter = normalizedTarget === 'any' ? '' : normalizedTarget;
  if (targetFilter || kind || policy) {
    const cliArgs = ['search', query, '--json', '--page-size', String(Math.min(limit, 20))];
    if (targetFilter) cliArgs.push('--target', targetFilter);
    if (kind) cliArgs.push('--kind', kind);
    if (policy) cliArgs.push('--policy', policy);
    const { stdout, stderr } = await runTokrepoCli(cliArgs);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { stdout, stderr };
    }
    return { content: [{ type: 'text', text: jsonText('Filtered TokRepo search results', data) }] };
  }

  // Normalize: hyphens/underscores/dots → spaces for better matching
  const normalized = query.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({
    keyword: normalized,
    page: '1',
    page_size: String(Math.min(limit, 20)),
    sort_by: 'popular',
  });
  if (tag) {
    const tagMap = { agent: 11, coding: 7, efficiency: 10, 'cost-saving': 12, methodology: 15, 'data-analysis': 14, writing: 1, marketing: 16, learning: 17, research: 8 };
    if (tagMap[tag]) params.set('tag_id', String(tagMap[tag]));
  }

  const res = await apiGet(`/api/v1/tokenboard/workflows/list?${params}`);
  if (res.code !== 200 || !res.data?.list?.length) {
    // Suggest broader terms when no results
    const words = normalized.split(' ');
    let hint = 'Try broader keywords.';
    if (words.length > 1) {
      hint = `Try: "${words[0]}" or "${words.slice(0, 2).join(' ')}"`;
    }
    return { content: [{ type: 'text', text: `No assets found for "${query}". ${hint}` }] };
  }

  const items = res.data.list.slice(0, limit);
  const candidates = items.map(item => buildCandidate(
    item,
    normalizedTarget,
    scoreDiscoveryCandidate(item, normalized, normalizedTarget, {}),
  ));
  const lines = candidates.map((candidate, i) => {
    const item = items[i] || {};
    const tags = (item.tags || []).map(t => t.name || t.slug).join(', ');
    // Truncate description to keep agent context concise
    let desc = candidate.description || item.description || '';
    if (desc.length > 120) desc = desc.substring(0, 117) + '...';
    return [
      `${i + 1}. **${candidate.title}**`,
      `   ${desc}`,
      `   Tags: ${tags || 'general'} | ★ ${item.vote_count || 0} | 👁 ${item.view_count || 0}`,
      `   Agent Readiness: ${candidate.agent_readiness.score}/100 (${candidate.agent_readiness.status}) | kind=${candidate.capability.kind || 'unknown'} | policy=${candidate.fit.policy || 'unknown'}`,
      `   Plan: call \`tokrepo_install_plan\` with uuid \`${candidate.uuid}\``,
      `   Install: \`tokrepo install ${candidate.uuid} --dry-run --json\``,
      `   URL: ${candidate.url}`,
    ].join('\n');
  });

  const text = `Found ${res.data.total} assets for "${query}" (showing ${items.length}):\n\n${lines.join('\n\n')}`;
  return {
    structuredContent: { candidates },
    content: [{ type: 'text', text }],
  };
}

async function handleDetail(args) {
  const { uuid } = args;
  const res = await apiGet(`/api/v1/tokenboard/workflows/detail?uuid=${encodeURIComponent(uuid)}`);
  if (res.code !== 200 || !res.data?.workflow) {
    return { content: [{ type: 'text', text: `Asset not found: ${uuid}` }] };
  }

  const w = res.data.workflow;
  const agentAssetContract = buildAgentAssetContract(w, 'codex', { has_plan: true });
  const tags = (w.tags || []).map(t => t.name || t.slug).join(', ');
  const steps = (w.steps || []).map((s, i) => {
    const content = s.prompt_template || s.description || '';
    return `### Step ${i + 1}: ${s.title}\n${content.substring(0, 500)}${content.length > 500 ? '...' : ''}`;
  }).join('\n\n');

  const text = [
    `# ${w.title}`,
    ``,
    `**Description**: ${w.description}`,
    `**Tags**: ${tags}`,
    `**Stars**: ${w.vote_count || 0} | **Views**: ${w.view_count || 0} | **Forks**: ${w.fork_count || 0}`,
    `**Author**: ${w.author_name || 'Anonymous'}`,
    `**URL**: ${TOKREPO_URL}/en/workflows/${w.uuid}`,
    `**Agent Readiness**: ${agentAssetContract.readiness.score}/100 (${agentAssetContract.readiness.status})`,
    `**Plan**: call \`tokrepo_install_plan\` with uuid \`${w.uuid}\` before installing`,
    `**Install**: \`tokrepo install ${w.uuid} --dry-run --json\``,
    ``,
    jsonText('Agent asset contract', agentAssetContract),
    ``,
    steps,
  ].join('\n');

  return {
    structuredContent: {
      agent_asset_contract: agentAssetContract,
      agent_readiness: agentAssetContract.readiness,
    },
    content: [{ type: 'text', text }],
  };
}

async function handleInstall(args) {
  const { uuid } = args;
  try {
    const raw = await apiGetText(`/api/v1/tokenboard/workflows/raw?uuid=${encodeURIComponent(uuid)}`);
    if (!raw || raw.includes('"code":')) {
      return { content: [{ type: 'text', text: `Could not fetch raw content for ${uuid}. Try: tokrepo install ${uuid}` }] };
    }
    return { content: [{ type: 'text', text: `# Raw content for asset ${uuid}\n\nInstall via CLI: \`npx tokrepo install ${uuid}\`\n\n---\n\n${raw}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error fetching asset: ${e.message}. Try: tokrepo install ${uuid}` }] };
  }
}

async function handleInstallPlan(args) {
  const { uuid, target = 'codex' } = args;
  if (target === 'codex') {
    try {
      const { stdout, stderr } = await runTokrepoCli(['plan', uuid, '--target', target]);
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        data = { stdout, stderr };
      }
      const decision = planPolicyDecision(data);
      const command = decision === 'allow'
        ? `tokrepo install ${data.asset_uuid || uuid} --target ${target} --yes`
        : `tokrepo install ${data.asset_uuid || uuid} --target ${target} --dry-run --json`;
      const trustData = await fetchTrust(data.asset_uuid || uuid);
      const trust = trustBlock(trustData, { signature_status: data.signature_status });
      const gate = trustGate(trust);
      data.trust = trust;
      data.trust_gate = gate;
      if (gate.gate === 'block') {
        data.blockers = Array.isArray(data.blockers) ? data.blockers : [];
        data.blockers.push({
          code: 'TRUST_BELOW_THRESHOLD',
          severity: 'high',
          message: `trust_score ${trust.score ?? 'n/a'} < TOKREPO_MIN_TRUST (${MIN_TRUST}). Confirm with user before install.`,
        });
      }
      data.agent_asset_contract = buildAgentAssetContract({}, target, {
        id: data.asset_uuid || uuid,
        plan: data,
        metadata: data.metadata || {},
        fit: data.agent_fit || {},
        trust,
        has_plan: true,
      });
      data.agent_readiness = data.agent_asset_contract.readiness;
      const trustLine = trust.score != null
        ? `Trust: ${trust.score.toFixed(3)} (${trust.decision}) gate=${gate.gate}`
        : `Trust: unknown gate=${gate.gate}`;
      return {
        structuredContent: {
          install_plan: data,
          agent_asset_contract: data.agent_asset_contract,
          agent_readiness: data.agent_readiness,
        },
        content: [{
          type: 'text',
          text: jsonText(`Install plan v${data.schema_version || 1} for ${data.asset_title || uuid}\n\nPolicy: ${decision} | ${trustLine}\nCLI: ${command}`, data),
        }],
      };
    } catch {
      // Fall back to the API plan below when the CLI is unavailable.
    }
  }
  const plan = await fetchInstallPlan(uuid, target);
  const decision = planPolicyDecision(plan);
  const command = decision === 'allow'
    ? `tokrepo install ${plan.asset_uuid || uuid} --target ${target} --yes`
    : `tokrepo install ${plan.asset_uuid || uuid} --target ${target} --dry-run --json`;
  const trustData = await fetchTrust(plan.asset_uuid || uuid);
  const trust = trustBlock(trustData, { signature_status: plan.signature_status });
  const gate = trustGate(trust);
  plan.trust = trust;
  plan.trust_gate = gate;
  if (gate.gate === 'block') {
    plan.blockers = Array.isArray(plan.blockers) ? plan.blockers : [];
    plan.blockers.push({
      code: 'TRUST_BELOW_THRESHOLD',
      severity: 'high',
      message: `trust_score ${trust.score ?? 'n/a'} < TOKREPO_MIN_TRUST (${MIN_TRUST}). Confirm with user before install.`,
    });
  }
  plan.agent_asset_contract = buildAgentAssetContract({}, target, {
    id: plan.asset_uuid || uuid,
    plan,
    metadata: plan.metadata || {},
    fit: plan.agent_fit || {},
    trust,
    has_plan: true,
  });
  plan.agent_readiness = plan.agent_asset_contract.readiness;
  const trustLine = trust.score != null
    ? `Trust: ${trust.score.toFixed(3)} (${trust.decision}) gate=${gate.gate}`
    : `Trust: unknown gate=${gate.gate}`;
  return {
    structuredContent: {
      install_plan: plan,
      agent_asset_contract: plan.agent_asset_contract,
      agent_readiness: plan.agent_readiness,
    },
    content: [{
      type: 'text',
      text: jsonText(`Install plan v${plan.schema_version || 1} for ${plan.asset_title || uuid}\n\nPolicy: ${decision} | ${trustLine}\nCLI: ${command}`, plan),
    }],
  };
}

async function handleVerify(args) {
  const {
    uuid = '00000000-0000-4000-8000-000000000001',
    target = 'codex',
    strict = false,
    offline = false,
  } = args || {};
  const cliArgs = ['verify', uuid, '--target', target, '--json'];
  if (strict) cliArgs.push('--strict');
  if (offline) cliArgs.push('--offline');
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  const status = data?.status || 'unknown';
  return {
    isError: status === 'fail',
    content: [{
      type: 'text',
      text: jsonText(`TokRepo asset verification (${status})`, data),
    }],
  };
}

async function handleCodexInstall(args) {
  const {
    uuid,
    dry_run = true,
    stage = false,
    confirm = false,
    approve_risk = false,
  } = args;

  const plan = await fetchInstallPlan(uuid, 'codex');
  const decision = planPolicyDecision(plan);
  if (dry_run !== false) {
    const cliArgs = ['install', plan.asset_uuid || uuid, '--target', 'codex', '--dry-run', '--json'];
    if (stage) cliArgs.push('--stage');
    const { stdout, stderr } = await runTokrepoCli(cliArgs);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { stdout, stderr };
    }
    return {
      content: [{
        type: 'text',
        text: jsonText(`Dry run only. Policy: ${decision}. Set dry_run=false and confirm=true to write files.`, data),
      }],
    };
  }

  if (!confirm) {
    const cliArgs = ['install', plan.asset_uuid || uuid, '--target', 'codex', '--dry-run', '--json'];
    const { stdout, stderr } = await runTokrepoCli(cliArgs);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { stdout, stderr };
    }
    return {
      isError: true,
      content: [{
        type: 'text',
        text: jsonText('Refused to write files because confirm=true was not provided. Dry-run plan follows.', data),
      }],
    };
  }
  if (decision === 'deny') {
    return {
      isError: true,
      content: [{ type: 'text', text: jsonText('Install policy denied this asset.', plan) }],
    };
  }
  if ((decision === 'confirm' || decision === 'stage_only') && !stage && !approve_risk) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: jsonText(`Policy is ${decision}. Re-run with stage=true to avoid activation, or approve_risk=true to activate anyway.`, plan),
      }],
    };
  }

  const cliArgs = ['install', plan.asset_uuid || uuid, '--target', 'codex', '--json', '--yes'];
  if (stage) cliArgs.push('--stage');
  if (approve_risk) cliArgs.push('--approve-mcp');
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText('Codex install result', data) }] };
}

async function handleClonePlan(args) {
  const { user, keyword = '', types = '' } = args;
  const cliArgs = ['clone', user, '--target', 'codex', '--dry-run', '--json'];
  if (keyword) cliArgs.push('--keyword', keyword);
  if (types) cliArgs.push('--types', types);
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText('Bulk Codex clone dry-run plan', data) }] };
}

async function handleInstalled() {
  const { stdout, stderr } = await runTokrepoCli(['installed', '--target', 'codex', '--json']);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText('TokRepo Codex installed assets', data) }] };
}

async function handleUpdate(args) {
  const { dry_run = true, confirm = false, stage = false, approve_risk = false } = args || {};
  const cliArgs = ['sync-installed', '--target', 'codex', '--json'];
  if (dry_run !== false) cliArgs.push('--dry-run');
  if (stage) cliArgs.push('--stage');
  if (approve_risk) cliArgs.push('--approve-mcp');

  if (dry_run === false && !confirm) {
    cliArgs.push('--dry-run');
    const { stdout, stderr } = await runTokrepoCli(cliArgs);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { stdout, stderr };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: jsonText('Refused to update because confirm=true was not provided. Dry-run plan follows.', data) }],
    };
  }

  if (dry_run === false) cliArgs.push('--update');
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText(dry_run === false ? 'TokRepo Codex update result' : 'TokRepo Codex update dry-run', data) }] };
}

async function handleUninstall(args) {
  const { uuid, dry_run = true, confirm = false, force = false } = args;
  const cliArgs = ['uninstall', uuid, '--target', 'codex', '--json'];
  if (dry_run !== false) cliArgs.push('--dry-run');
  if (force) cliArgs.push('--force');

  if (dry_run === false && !confirm) {
    cliArgs.push('--dry-run');
    const { stdout, stderr } = await runTokrepoCli(cliArgs);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { stdout, stderr };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: jsonText('Refused to uninstall because confirm=true was not provided. Dry-run plan follows.', data) }],
    };
  }

  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText(dry_run === false ? 'TokRepo Codex uninstall result' : 'TokRepo Codex uninstall dry-run', data) }] };
}

async function handleRollback(args) {
  const { session_id = '', last = true, dry_run = true, confirm = false, force = false } = args;
  const cliArgs = ['rollback', '--target', 'codex', '--json'];
  if (session_id) cliArgs.push(session_id);
  else if (last !== false) cliArgs.push('--last');
  if (dry_run !== false) cliArgs.push('--dry-run');
  if (force) cliArgs.push('--force');

  if (dry_run === false && !confirm) {
    cliArgs.push('--dry-run');
    const { stdout, stderr } = await runTokrepoCli(cliArgs);
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { stdout, stderr };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: jsonText('Refused to roll back because confirm=true was not provided. Dry-run plan follows.', data) }],
    };
  }

  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText(dry_run === false ? 'TokRepo Codex rollback result' : 'TokRepo Codex rollback dry-run', data) }] };
}

async function handleHandoffPlan(args) {
  const { paths = [], limit = 12 } = args || {};
  const cliArgs = ['agent-handoff', '--json', '--limit', String(Math.min(Math.max(Number(limit) || 12, 1), 30))];
  for (const inputPath of asArray(paths)) {
    if (inputPath) cliArgs.push(String(inputPath));
  }
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText('TokRepo agent handoff plan', data) }] };
}

async function handleResolveCapability(args) {
  const {
    task = '',
    target = args?.constraints?.target || 'any',
    kind = args?.constraints?.kind || '',
    policy = args?.constraints?.policy || '',
    limit = 6,
    min_trust = 70,
    min_fit = 70,
    offline = false,
  } = args || {};
  const taskText = compactText(task, 500);
  if (!taskText) {
    return { content: [{ type: 'text', text: 'Error: task is required.' }], isError: true };
  }
  const cliArgs = [
    'resolve',
    taskText,
    '--json',
    '--target',
    String(target || 'any'),
    '--limit',
    String(Math.min(Math.max(Number(limit) || 6, 1), 10)),
    '--min-trust',
    String(Math.min(Math.max(Number(min_trust) || 70, 0), 100)),
    '--min-fit',
    String(Math.min(Math.max(Number(min_fit) || 70, 0), 100)),
  ];
  if (kind) cliArgs.push('--kind', String(kind));
  if (policy) cliArgs.push('--policy', String(policy));
  if (offline) cliArgs.push('--offline');

  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return {
    structuredContent: data,
    content: [{ type: 'text', text: jsonText('TokRepo capability resolution', data) }],
  };
}

async function handleHarvest(args) {
  const { paths = [], changed = false, limit = 12 } = args || {};
  const cliArgs = ['harvest', '--json', '--limit', String(Math.min(Math.max(Number(limit) || 12, 1), 30))];
  if (changed) cliArgs.push('--changed');
  for (const inputPath of asArray(paths)) {
    if (inputPath) cliArgs.push(String(inputPath));
  }
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return {
    structuredContent: data,
    content: [{ type: 'text', text: jsonText('TokRepo harvest report', data) }],
  };
}

async function handleEvalAgent(args) {
  const { uuid = '', keyword = '' } = args || {};
  const cliArgs = ['eval-agent', '--json'];
  if (uuid) cliArgs.push('--uuid', uuid);
  if (keyword) cliArgs.push('--keyword', keyword);
  const { stdout, stderr } = await runTokrepoCli(cliArgs);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = { stdout, stderr };
  }
  return { content: [{ type: 'text', text: jsonText('TokRepo agent eval result', data) }] };
}

async function handleTrending(args) {
  const { sort = 'popular', limit = 10 } = args;
  const params = new URLSearchParams({
    page: '1',
    page_size: String(Math.min(limit, 20)),
    sort_by: sort,
  });

  const res = await apiGet(`/api/v1/tokenboard/workflows/list?${params}`);
  if (res.code !== 200 || !res.data?.list?.length) {
    return { content: [{ type: 'text', text: 'No trending assets found.' }] };
  }

  const items = res.data.list.slice(0, limit);
  const lines = items.map((item, i) => {
    const tags = (item.tags || []).map(t => t.name || t.slug).join(', ');
    return `${i + 1}. **${item.title}** — ${item.description || ''}\n   ${tags} | ★ ${item.vote_count || 0} | 👁 ${item.view_count || 0} | Install: \`tokrepo install ${item.uuid}\``;
  });

  const text = `Trending AI assets on TokRepo (${sort}):\n\n${lines.join('\n\n')}\n\nBrowse more: ${TOKREPO_URL}`;
  return { content: [{ type: 'text', text }] };
}

// Walk the asset relationship graph for one asset. Surfaces requires/extends/co_used
// neighbors so agents can discover related assets BEFORE planning installs.
async function handleEdges(args) {
  const { uuid = '', slug = '', direction = 'both', types = '' } = args || {};
  if (!uuid && !slug) {
    return { content: [{ type: 'text', text: 'tokrepo_edges: provide uuid or slug.' }] };
  }
  const params = new URLSearchParams();
  if (uuid) params.set('uuid', uuid);
  if (slug && !uuid) params.set('slug', slug);
  if (direction && direction !== 'both') params.set('direction', direction);
  if (types) params.set('types', types);

  const res = await apiGet(`/api/v1/tokenboard/workflows/edges?${params}`);
  if (res.code !== 200) {
    return { content: [{ type: 'text', text: `tokrepo_edges error: ${res.message || 'unknown'}` }] };
  }
  const data = res.data || { outbound: [], inbound: [] };
  const out = Array.isArray(data.outbound) ? data.outbound : [];
  const inb = Array.isArray(data.inbound) ? data.inbound : [];

  const fmtList = (label, list) => {
    if (!list.length) return `${label}: (none)`;
    const rows = list.slice(0, 20).map(e =>
      `  • [${e.edge_type}/${e.source}] ${e.title || e.slug || e.uuid} — ${e.slug || e.uuid} (kind=${e.asset_kind || 'asset'}${e.weight ? `, w=${e.weight.toFixed(2)}` : ''})`,
    );
    return `${label} (${list.length}):\n${rows.join('\n')}`;
  };

  const summary = [
    `Asset graph for ${uuid || slug}`,
    fmtList('Outbound (this asset → others)', out),
    fmtList('Inbound (others → this asset)', inb),
    '',
    'Edge types: requires (hard dep) · extends (soft pair) · co_used (behavior-derived).',
    'Use tokrepo_detail / tokrepo_install_plan on each neighbor uuid/slug to drill in.',
  ].join('\n');

  return {
    structuredContent: { outbound: out, inbound: inb },
    content: [{ type: 'text', text: summary }],
  };
}

async function handlePush(args) {
  const token = requireToken();
  const { title, files, description, tags, visibility = 1 } = args;
  if (!title || !files?.length) {
    return { content: [{ type: 'text', text: 'Error: title and files are required.' }], isError: true };
  }

  const pushFiles = files.map(f => ({
    name: f.name,
    content: f.content,
    type: f.type || 'other',
  }));

  const totalChars = pushFiles.reduce((s, f) => s + f.content.length, 0);

  const res = await apiPost('/api/v1/tokenboard/push/upsert', {
    title,
    description: description || '',
    files: pushFiles,
    tags: tags || [],
    token_cost: String(Math.round(totalChars / 4)),
    visibility,
  }, token);

  if (res.code !== 200) {
    return { content: [{ type: 'text', text: `Push failed: ${res.message || 'Unknown error'}` }], isError: true };
  }

  const d = res.data;
  const action = d.action === 'created' ? 'Created new asset'
    : d.action === 'updated' ? 'Updated existing asset'
    : 'No changes (content identical)';

  return { content: [{ type: 'text', text: `${action}\n\nURL: ${d.url}\nUUID: ${d.uuid}` }] };
}

async function handleStatus(args) {
  const token = requireToken();
  const { assets } = args;
  if (!assets?.length) {
    return { content: [{ type: 'text', text: 'No assets to compare.' }] };
  }

  // Compute content hashes matching backend format
  const diffAssets = assets.map(a => {
    const h = crypto.createHash('sha256');
    for (const f of (a.files || [])) {
      h.update(f.name);
      h.update('\0');
      h.update(f.content);
      h.update('\0');
    }
    return { title: a.title, content_hash: h.digest('hex') };
  });

  const res = await apiPost('/api/v1/tokenboard/push/diff', { assets: diffAssets }, token);
  if (res.code !== 200) {
    return { content: [{ type: 'text', text: `Status check failed: ${res.message || 'Unknown error'}` }], isError: true };
  }

  const results = res.data.results || [];
  const lines = results.map(r => {
    const icon = r.status === 'new' ? '+ new' : r.status === 'updated' ? '~ modified' : '= unchanged';
    return `${icon}  ${r.title}${r.remote_uuid ? ` (${r.remote_uuid.substring(0, 8)}...)` : ''}`;
  });

  const newCount = results.filter(r => r.status === 'new').length;
  const updatedCount = results.filter(r => r.status === 'updated').length;

  let summary = '';
  if (newCount || updatedCount) {
    summary = `\n${newCount ? newCount + ' new' : ''}${newCount && updatedCount ? ', ' : ''}${updatedCount ? updatedCount + ' modified' : ''}. Use tokrepo_push to sync.`;
  } else {
    summary = '\nEverything up to date.';
  }

  return { content: [{ type: 'text', text: lines.join('\n') + summary }] };
}

async function handleListMy(args) {
  const token = requireToken();
  const { page = 1, limit = 20 } = args || {};
  const size = Math.min(limit, 50);

  const res = await apiGetAuth(`/api/v1/tokenboard/workflows/my?page=${page}&page_size=${size}`, token);
  if (res.code !== 200) {
    return { content: [{ type: 'text', text: `Failed: ${res.message || 'Unknown error'}` }], isError: true };
  }

  const items = res.data?.list || res.data?.items || [];
  if (!items.length) {
    return { content: [{ type: 'text', text: 'No assets found. Push your first asset with tokrepo_push!' }] };
  }

  const lines = items.map((item, i) => {
    return `${i + 1}. **${item.title}** (${item.visibility === 1 ? 'public' : 'private'})\n   UUID: ${item.uuid} | Views: ${item.view_count || 0} | Stars: ${item.vote_count || 0}`;
  });

  const total = res.data?.total || items.length;
  return { content: [{ type: 'text', text: `Your assets (${total} total, page ${page}):\n\n${lines.join('\n\n')}` }] };
}

// ─── MCP JSON-RPC Handler ───

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: CAPABILITIES, serverInfo: SERVER_INFO } };

    case 'notifications/initialized':
      return null; // no response for notifications

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: EXPOSED_TOOLS } };

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      let result;
      try {
        if (!EXPOSED_TOOL_NAMES.has(name)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            },
          };
        }
        switch (name) {
          case 'tokrepo_session_init': result = await handleSessionInit(args || {}); break;
          case 'tokrepo_find_for_task': result = await handleFindForTask(args || {}); break;
          case 'tokrepo_discover': result = await handleDiscover(args || {}); break;
          case 'tokrepo_resolve_capability': result = await handleResolveCapability(args || {}); break;
          case 'tokrepo_search': result = await handleSearch(args || {}); break;
          case 'tokrepo_detail': result = await handleDetail(args || {}); break;
          case 'tokrepo_edges': result = await handleEdges(args || {}); break;
          case 'tokrepo_install': result = await handleInstall(args || {}); break;
          case 'tokrepo_install_plan': result = await handleInstallPlan(args || {}); break;
          case 'tokrepo_verify': result = await handleVerify(args || {}); break;
          case 'tokrepo_codex_install': result = await handleCodexInstall(args || {}); break;
          case 'tokrepo_clone_plan': result = await handleClonePlan(args || {}); break;
          case 'tokrepo_installed': result = await handleInstalled(args || {}); break;
          case 'tokrepo_update': result = await handleUpdate(args || {}); break;
          case 'tokrepo_uninstall': result = await handleUninstall(args || {}); break;
          case 'tokrepo_rollback': result = await handleRollback(args || {}); break;
          case 'tokrepo_handoff_plan': result = await handleHandoffPlan(args || {}); break;
          case 'tokrepo_harvest': result = await handleHarvest(args || {}); break;
          case 'tokrepo_eval_agent': result = await handleEvalAgent(args || {}); break;
          case 'tokrepo_trending': result = await handleTrending(args || {}); break;
          case 'tokrepo_push': result = await handlePush(args || {}); break;
          case 'tokrepo_status': result = await handleStatus(args || {}); break;
          case 'tokrepo_list_my': result = await handleListMy(args || {}); break;
          default: result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
      } catch (e) {
        result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
      trackAgentEventForTool(name, args || {}, result);
      return { jsonrpc: '2.0', id, result };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ─── Stdio Transport ───

function main() {
  let buffer = '';
  let pending = 0;
  let inputEnded = false;

  const maybeExit = () => {
    if (inputEnded && pending === 0) process.exit(0);
  };
  const writeJson = (payload) => new Promise((resolve, reject) => {
    let line;
    try {
      line = JSON.stringify(payload) + '\n';
    } catch (e) {
      reject(e);
      return;
    }
    process.stdout.write(line, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    // Process complete JSON-RPC messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        pending++;
        handleRequest(msg).then((response) => {
          if (response) {
            return writeJson(response);
          }
          return undefined;
        }).catch((e) => {
          return writeJson({
            jsonrpc: '2.0',
            id: msg.id || null,
            error: { code: -32603, message: e.message },
          });
        }).finally(() => {
          pending--;
          maybeExit();
        });
      } catch (e) {
        // Skip malformed JSON
      }
    }
  });

  process.stdin.on('end', () => {
    inputEnded = true;
    maybeExit();
  });

  // Log to stderr (not stdout, which is the MCP transport)
  process.stderr.write(`TokRepo MCP Server v${SERVER_VERSION} started${TOKREPO_TOKEN ? ' (authenticated)' : ' (read-only, set TOKREPO_TOKEN for write access)'}\n`);
}

main();
