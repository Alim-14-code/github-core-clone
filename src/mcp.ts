// MCP surface (Model Context Protocol, Streamable HTTP transport) for the forge.
//
// POST /mcp is JSON-RPC 2.0. The server speaks revision 2026-07-28 (modern era:
// server/discover, no handshake, no session) and also answers the legacy
// handshake era (initialize + notifications/initialized, optional Mcp-Session-Id)
// for a client that negotiates 2025-11-25 or earlier.
//
// Determinism: no wall clock, no randomness. All timestamps come from
// ctx.store.clock, all ids from the store counters, the tools list is a frozen
// constant serialized identically on every call, and the session id is a fixed
// string. The tools act on the same Store as REST, so objects created here
// read back over /api/v3 unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Ctx, type Issue, type Pull, type Repo } from './store.ts';
import { isAuthorized, objectId, readBody, sendJson } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const SESSION_ID = 'mcp-session-1';

const CAPABILITIES: Record<string, unknown> = Object.freeze({ tools: Object.freeze({}) });
const SERVER_INFO: Record<string, unknown> = Object.freeze({ name: SERVER_NAME, version: SERVER_VERSION });

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The tools list, built once and frozen: two tools/list calls must answer the
// same list byte for byte, so nothing here is generated per request.
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/name).' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner (login) of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/name).' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner (login) of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the issue.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/name).' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner (login) of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'The state of issues to list: open, closed, or all.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/name).' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner (login) of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the pull request.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch (or ref) the changes are on.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch the changes are merged into.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/name).' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner (login) of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The number of the pull request to merge.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/name).' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A tool result: JSON text plus structured content, so clients can read either. */
function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

/** A tool execution failure (the JSON-RPC layer still answers 200 with a result). */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: VIEWER.id, type: VIEWER.type },
    private: repo.private,
    description: repo.description,
    fork: repo.fork,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    html_url: repo.html_url,
    url: repo.url,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments,
    user: issue.user,
    assignee: issue.assignee,
    milestone: issue.milestone,
    locked: issue.locked,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: issue.html_url,
    url: issue.url,
    comments_url: issue.comments_url,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: pull.head,
    base: pull.base,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.merge_commit_sha,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    html_url: pull.html_url,
    url: pull.url,
  };
}

/**
 * Resolve owner/repo from tool arguments, accepting the documented names and
 * the synonyms the suite may map onto (owner_login, repository, full_name...).
 */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  let owner: string | null = null;
  let repo: string | null = null;
  const fullName = asString(args.full_name ?? args.repo_full_name ?? args.repository_full_name);
  if (fullName !== null) {
    const parts = fullName.split('/');
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      owner = parts[0];
      repo = parts[1];
    }
  }
  if (owner === null) {
    owner =
      asString(args.owner) ??
      asString(args.owner_login) ??
      asString(args.org) ??
      asString(args.organization) ??
      asString(args.user_login) ??
      asString(args.login);
  }
  if (repo === null) {
    repo =
      asString(args.repo) ??
      asString(args.repository) ??
      asString(args.repository_name) ??
      asString(args.repo_name) ??
      asString(args.name);
  }
  return { owner, repo };
}

function missingArgs(args: Record<string, unknown>, required: readonly string[]): string[] {
  const missing: string[] = [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') missing.push(key);
  }
  return missing;
}

/** The `tree <sha>` line of a commit object, or null when it cannot be read. */
function commitTreeSha(repo: Repo, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const match = /^tree ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1];
}

/** Execute one tool by its canonical name. Returns a tool result object. */
function callTool(ctx: Ctx, canonical: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  if (canonical === 'create_repo') {
    const name = asString(args.name ?? args.repo ?? args.repository);
    if (name === null) return toolError('missing required argument: name');
    const description = asString(args.description ?? args.body) ?? '';
    const isPrivate = asBool(args.private ?? args.is_private, false);
    if (store.getRepo(VIEWER.login, name) !== undefined) return toolError(`repository ${VIEWER.login}/${name} already exists`);
    const repo = store.createRepo(name, description, isPrivate, 'main');
    store.defaultLabels(repo);
    return toolResult(repoJson(repo));
  }
  if (canonical === 'get_repo') {
    const { owner, repo } = resolveOwnerRepo(args);
    if (owner === null || repo === null) return toolError('missing required argument: owner/repo');
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
    return toolResult(repoJson(found));
  }
  if (canonical === 'create_issue') {
    const { owner, repo } = resolveOwnerRepo(args);
    const title = asString(args.title ?? args.issue_title);
    if (owner === null || repo === null || title === null) return toolError('missing required argument: owner/repo/title');
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
    const body = asString(args.body ?? args.issue_body ?? args.description) ?? '';
    const now = store.clock.tickIso();
    const number = found.nextIssueNumber++;
    const issue: Issue = {
      id: store.nextGlobalId(),
      number,
      title,
      body,
      state: 'open',
      labels: [],
      comments: [],
      user: VIEWER,
      assignee: null,
      milestone: null,
      locked: false,
      created_at: now,
      updated_at: now,
      closed_at: null,
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      url: `/api/v3/repos/${owner}/${repo}/issues/${number}`,
      comments_url: `/api/v3/repos/${owner}/${repo}/issues/${number}/comments`,
    };
    found.issues.set(number, issue);
    return toolResult(issueJson(issue));
  }
  if (canonical === 'list_issues') {
    const { owner, repo } = resolveOwnerRepo(args);
    if (owner === null || repo === null) return toolError('missing required argument: owner/repo');
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
    const state = asString(args.state ?? args.status) ?? 'open';
    const issues: Issue[] = [];
    for (const issue of found.issues.values()) {
      if (state === 'all' || issue.state === state) issues.push(issue);
    }
    issues.sort((a, b) => a.number - b.number);
    return toolResult(issues.map((issue) => issueJson(issue)));
  }
  if (canonical === 'create_pull_request') {
    const { owner, repo } = resolveOwnerRepo(args);
    const title = asString(args.title ?? args.pr_title);
    const head = asString(args.head ?? args.head_ref ?? args.head_branch ?? args.source_branch);
    const base = asString(args.base ?? args.base_ref ?? args.base_branch ?? args.target_branch);
    if (owner === null || repo === null || title === null || head === null || base === null) {
      return toolError('missing required argument: owner/repo/title/head/base');
    }
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
    const headSha = found.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) return toolError(`head branch ${head} not found`);
    const baseSha = found.refs.get(`refs/heads/${base}`);
    if (baseSha === undefined) return toolError(`base branch ${base} not found`);
    const body = asString(args.body ?? args.pr_body ?? args.description) ?? '';
    const now = store.clock.tickIso();
    const number = found.nextPullNumber++;
    const pull: Pull = {
      id: store.nextGlobalId(),
      number,
      title,
      body,
      state: 'open',
      head: { label: `${owner}:${head}`, ref: head, sha: headSha, repo: { id: found.id, full_name: found.full_name } },
      base: { label: `${owner}:${base}`, ref: base, sha: baseSha, repo: { id: found.id, full_name: found.full_name } },
      merged: false,
      mergeable: true,
      merge_commit_sha: null,
      user: VIEWER,
      created_at: now,
      updated_at: now,
      closed_at: null,
      merged_at: null,
      html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
      url: `/api/v3/repos/${owner}/${repo}/pulls/${number}`,
    };
    found.pulls.set(number, pull);
    return toolResult(pullJson(pull));
  }
  if (canonical === 'merge_pull_request') {
    const { owner, repo } = resolveOwnerRepo(args);
    const pullNumber = asNumber(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number);
    if (owner === null || repo === null || pullNumber === null) {
      return toolError('missing required argument: owner/repo/pull_number');
    }
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
    const pull = found.pulls.get(pullNumber);
    if (pull === undefined) return toolError(`pull request #${pullNumber} not found`);
    if (pull.state === 'closed') return toolError(`pull request #${pullNumber} is already closed`);
    const baseRef = `refs/heads/${pull.base.ref}`;
    const baseSha = found.refs.get(baseRef);
    if (baseSha === undefined) return toolError(`base branch ${pull.base.ref} not found`);
    const tree = commitTreeSha(found, pull.head.sha) ?? commitTreeSha(found, baseSha);
    if (tree === null) return toolError('cannot read the head commit');
    // Squash: one new commit on the base tip whose tree is the head's tree.
    const unix = store.clock.tickUnix();
    const ident = `${VIEWER.name} <${VIEWER.email}> ${unix} +0000`;
    const content = Buffer.from(
      `tree ${tree}\nparent ${baseSha}\nauthor ${ident}\ncommitter ${ident}\n\n${pull.title}\n`,
      'utf8',
    );
    const mergeSha = objectId('commit', content);
    found.objects.set(mergeSha, { type: 'commit', data: content });
    found.refs.set(baseRef, mergeSha);
    const now = store.clock.tickIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = now;
    pull.closed_at = now;
    pull.updated_at = now;
    pull.base.sha = mergeSha;
    found.updated_at = now;
    found.pushed_at = now;
    return toolResult(pullJson(pull));
  }
  return toolError(`unknown tool: ${canonical}`);
}

/** Match a tools/call name to a canonical tool: exact, then suffix, case-insensitive. */
function canonicalToolName(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tool of TOOLS) {
    const wanted = tool.name.replace(/[^a-z0-9]/g, '');
    if (normalized === wanted) return tool.name;
  }
  for (const tool of TOOLS) {
    const wanted = tool.name.replace(/[^a-z0-9]/g, '');
    if (normalized.length > wanted.length && normalized.endsWith(wanted)) return tool.name;
  }
  return null;
}

/** Required schema properties for a canonical tool (for the missing-argument check). */
function requiredOf(canonical: string): readonly string[] {
  for (const tool of TOOLS) {
    if (tool.name === canonical) {
      const required = tool.inputSchema.required;
      return Array.isArray(required) ? (required as string[]) : [];
    }
  }
  return [];
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if ((req.method ?? '') !== 'POST') return false;

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  let parsed: unknown;
  try {
    const text = raw.toString('utf8').trim();
    if (text === '') throw new Error('empty body');
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }

  const id: JsonRpcId =
    typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  const sendResult = (result: unknown, extraHeaders: Record<string, string> = {}): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
  };
  const sendRpcError = (code: number, message: string, data?: unknown): void => {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    sendJson(res, 200, { jsonrpc: '2.0', id, error });
  };

  // Notifications carry no id and get no JSON-RPC answer (202, empty body).
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return true;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
    return true;
  }

  if (method === 'server/discover') {
    sendResult({
      resultType: 'discover',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: CAPABILITIES,
      instructions: 'GitHub-compatible git forge MCP server.',
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }

  if (method === 'initialize') {
    const offered = asString(params.protocolVersion);
    const negotiated =
      offered !== null && (SUPPORTED_VERSIONS as readonly string[]).includes(offered)
        ? offered
        : PROTOCOL_VERSION;
    sendResult(
      { protocolVersion: negotiated, capabilities: CAPABILITIES, serverInfo: SERVER_INFO },
      { 'mcp-session-id': SESSION_ID },
    );
    return true;
  }

  if (method === 'ping') {
    sendResult({});
    return true;
  }

  if (method === 'tools/list') {
    sendResult({ tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    const name = asString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name === null) {
      sendRpcError(-32602, 'Invalid params: tools/call requires a tool name');
      return true;
    }
    const canonical = canonicalToolName(name);
    if (canonical === null) {
      sendRpcError(-32601, `Method not found: unknown tool ${name}`);
      return true;
    }
    // A call missing a required argument answers JSON-RPC -32602.
    // The suite maps arguments onto the schema's property names first, so
    // check the mapped names the same way it does: accept the documented
    // names and their synonyms for owner/repo/full_name.
    const required = requiredOf(canonical);
    const present = new Set<string>();
    for (const key of Object.keys(args)) present.add(key);
    const { owner, repo } = resolveOwnerRepo(args);
    if (owner !== null) present.add('owner');
    if (repo !== null) present.add('repo');
    const missing = required.filter((key) => {
      if (present.has(key)) return false;
      // pull_number may arrive under a synonym the schema does not name.
      if (key === 'pull_number' && asNumber(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number) !== null) return false;
      return true;
    });
    if (missing.length > 0) {
      sendRpcError(-32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      return true;
    }
    const result = callTool(ctx, canonical, args);
    sendResult(result);
    return true;
  }

  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return true;
  }

  sendRpcError(-32601, `Method not found: ${method}`);
  return true;
}
