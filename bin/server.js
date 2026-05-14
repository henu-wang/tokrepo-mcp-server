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
const SERVER_VERSION = '2.8.0';

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
    name: 'tokrepo_discover',
    description: 'Planning-time capability discovery for agents. Call this during autonomous planning when the task may need a reusable skill, MCP config, prompt, script, workflow, or other AI asset. Returns structured candidates, fit signals, and next MCP calls.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The user goal, subtask, or capability gap the agent is planning for.',
        },
        target: {
          type: 'string',
          description: 'Optional agent/runtime target. Use "any" for generic discovery.',
          enum: ['any', 'codex', 'claude_code', 'gemini_cli', 'cursor', 'windsurf', 'mcp_client'],
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
          description: 'Optional agent target filter. Use "any" or omit it for generic discovery.',
          enum: ['any', 'codex', 'claude_code', 'gemini_cli', 'cursor', 'windsurf', 'mcp_client'],
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
    description: 'Return an agent-native install plan v2 for a TokRepo asset. Use this before installing: it includes preconditions, actions, risk profile, policy decision, rollback, and post-install verification.',
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
    name: 'tokrepo_codex_install',
    description: 'Safely install a TokRepo asset into local Codex. Defaults to dry_run=true. To write files, set dry_run=false and confirm=true. Risky assets require stage=true or approve_risk=true.',
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
    description: 'Roll back a previous TokRepo Codex install session. Defaults to dry_run=true and last=true.',
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
  'tokrepo_discover',
  'tokrepo_search',
  'tokrepo_detail',
  'tokrepo_install_plan',
  'tokrepo_codex_install',
  'tokrepo_installed',
  'tokrepo_update',
  'tokrepo_uninstall',
  'tokrepo_rollback',
  'tokrepo_push',
]);

const EXPOSED_TOOLS = TOOLS.filter((tool) => EXPOSED_TOOL_NAMES.has(tool.name));

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
  if (name === 'tokrepo_discover') return 'mcp_discover';
  if (name === 'tokrepo_search') return 'mcp_search';
  if (name === 'tokrepo_detail') return 'mcp_detail';
  if (name === 'tokrepo_install_plan') return 'install_plan';
  if (name === 'tokrepo_codex_install') return args.dry_run === false ? 'install_apply' : 'install_dry_run';
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
    ranking,
    next_mcp_calls: [
      { tool: 'tokrepo_detail', arguments: { uuid } },
      { tool: 'tokrepo_install_plan', arguments: { uuid, target: planTarget } },
    ],
    commands: {
      inspect: `npx tokrepo detail ${uuid} --json`,
      dry_run_install: planTarget === 'codex'
        ? `npx tokrepo install ${uuid} --dry-run --json`
        : `npx tokrepo install ${uuid} --target ${planTarget} --dry-run --json`,
    },
    agent_use_contract: [
      'Use only if the capability matches the current subtask.',
      'Call tokrepo_detail before install to inspect content and metadata.',
      'Call tokrepo_install_plan and respect policy_decision before writing files.',
      'Prefer dry-run or stage-only when risk or fit is uncertain.',
      'After using it, verify the original task outcome and record failures.',
    ],
  };
}

// ─── Tool Handlers ───

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
    recommended_flow: [
      'During planning, call tokrepo_discover when the task exposes a capability gap.',
      'Rank candidates by fit, policy, trust, and whether the entrypoint matches the active agent runtime.',
      'Call tokrepo_detail for the top candidate before installation or use.',
      'Call tokrepo_install_plan and respect policy_decision, rollback, and verification steps.',
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
  const lines = items.map((item, i) => {
    const tags = (item.tags || []).map(t => t.name || t.slug).join(', ');
    // Truncate description to keep agent context concise
    let desc = item.description || '';
    if (desc.length > 120) desc = desc.substring(0, 117) + '...';
    return [
      `${i + 1}. **${item.title}**`,
      `   ${desc}`,
      `   Tags: ${tags || 'general'} | ★ ${item.vote_count || 0} | 👁 ${item.view_count || 0}`,
      `   Plan: call \`tokrepo_install_plan\` with uuid \`${item.uuid}\``,
      `   Install: \`tokrepo install ${item.uuid} --dry-run --json\``,
      `   URL: ${TOKREPO_URL}/en/workflows/${item.uuid}`,
    ].join('\n');
  });

  const text = `Found ${res.data.total} assets for "${query}" (showing ${items.length}):\n\n${lines.join('\n\n')}`;
  return { content: [{ type: 'text', text }] };
}

async function handleDetail(args) {
  const { uuid } = args;
  const res = await apiGet(`/api/v1/tokenboard/workflows/detail?uuid=${encodeURIComponent(uuid)}`);
  if (res.code !== 200 || !res.data?.workflow) {
    return { content: [{ type: 'text', text: `Asset not found: ${uuid}` }] };
  }

  const w = res.data.workflow;
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
    `**Plan**: call \`tokrepo_install_plan\` with uuid \`${w.uuid}\` before installing`,
    `**Install**: \`tokrepo install ${w.uuid} --dry-run --json\``,
    ``,
    steps,
  ].join('\n');

  return { content: [{ type: 'text', text }] };
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
  const plan = await fetchInstallPlan(uuid, target);
  const decision = planPolicyDecision(plan);
  const command = decision === 'allow'
    ? `tokrepo install ${plan.asset_uuid || uuid} --target ${target} --yes`
    : `tokrepo install ${plan.asset_uuid || uuid} --target ${target} --dry-run --json`;
  return {
    content: [{
      type: 'text',
      text: jsonText(`Install plan v${plan.schema_version || 1} for ${plan.asset_title || uuid}\n\nPolicy: ${decision}\nCLI: ${command}`, plan),
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
          case 'tokrepo_discover': result = await handleDiscover(args || {}); break;
          case 'tokrepo_search': result = await handleSearch(args || {}); break;
          case 'tokrepo_detail': result = await handleDetail(args || {}); break;
          case 'tokrepo_install': result = await handleInstall(args || {}); break;
          case 'tokrepo_install_plan': result = await handleInstallPlan(args || {}); break;
          case 'tokrepo_codex_install': result = await handleCodexInstall(args || {}); break;
          case 'tokrepo_clone_plan': result = await handleClonePlan(args || {}); break;
          case 'tokrepo_installed': result = await handleInstalled(args || {}); break;
          case 'tokrepo_update': result = await handleUpdate(args || {}); break;
          case 'tokrepo_uninstall': result = await handleUninstall(args || {}); break;
          case 'tokrepo_rollback': result = await handleRollback(args || {}); break;
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
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        }).catch((e) => {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id || null,
            error: { code: -32603, message: e.message },
          }) + '\n');
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
