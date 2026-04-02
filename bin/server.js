#!/usr/bin/env node

/**
 * TokRepo MCP Server
 *
 * Search, browse, and install AI assets from TokRepo via the Model Context Protocol.
 * Works with Claude Code, Cursor, Codex, Gemini CLI, and any MCP client.
 *
 * Usage:
 *   claude mcp add tokrepo -- npx @tokrepo/mcp-server
 *   npx @tokrepo/mcp-server
 */

const https = require('https');
const readline = require('readline');

const API_BASE = 'https://api.tokrepo.com';
const TOKREPO_URL = 'https://tokrepo.com';

// ─── MCP Protocol (JSON-RPC over stdio) ───

const SERVER_INFO = {
  name: 'tokrepo',
  version: '1.0.0',
};

const CAPABILITIES = {
  tools: {},
};

const TOOLS = [
  {
    name: 'tokrepo_search',
    description: 'Search TokRepo for AI assets (skills, prompts, MCP configs, scripts, workflows). Returns matching assets with titles, descriptions, tags, stars, and install commands. Use this when the user asks to find AI tools, MCP servers, Claude skills, prompts, or workflows.',
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
];

// ─── HTTP Helper ───

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 10000 }, (res) => {
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
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ─── Tool Handlers ───

async function handleSearch(args) {
  const { query, tag, limit = 10 } = args;
  const params = new URLSearchParams({
    keyword: query,
    page: '1',
    page_size: String(Math.min(limit, 20)),
    sort_by: 'popular',
  });
  if (tag) {
    // Map tag name to tag_id (approximate)
    const tagMap = { agent: 11, coding: 7, efficiency: 10, 'cost-saving': 12, methodology: 15, 'data-analysis': 14, writing: 1, marketing: 16, learning: 17, research: 8 };
    if (tagMap[tag]) params.set('tag_id', String(tagMap[tag]));
  }

  const res = await apiGet(`/api/v1/tokenboard/workflows/list?${params}`);
  if (res.code !== 200 || !res.data?.list?.length) {
    return { content: [{ type: 'text', text: `No assets found for "${query}". Try broader keywords.` }] };
  }

  const items = res.data.list.slice(0, limit);
  const lines = items.map((item, i) => {
    const tags = (item.tags || []).map(t => t.name || t.slug).join(', ');
    return [
      `${i + 1}. **${item.title}**`,
      `   ${item.description || ''}`,
      `   Tags: ${tags || 'general'} | ★ ${item.vote_count || 0} | 👁 ${item.view_count || 0}`,
      `   Install: \`tokrepo install ${item.uuid}\``,
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
    `**Install**: \`tokrepo install ${w.uuid}\``,
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

// ─── MCP JSON-RPC Handler ───

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: CAPABILITIES, serverInfo: SERVER_INFO } };

    case 'notifications/initialized':
      return null; // no response for notifications

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      let result;
      try {
        switch (name) {
          case 'tokrepo_search': result = await handleSearch(args || {}); break;
          case 'tokrepo_detail': result = await handleDetail(args || {}); break;
          case 'tokrepo_install': result = await handleInstall(args || {}); break;
          case 'tokrepo_trending': result = await handleTrending(args || {}); break;
          default: result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
      } catch (e) {
        result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
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
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let buffer = '';

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
        });
      } catch (e) {
        // Skip malformed JSON
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));

  // Log to stderr (not stdout, which is the MCP transport)
  process.stderr.write('TokRepo MCP Server v1.0.0 started\n');
}

main();
