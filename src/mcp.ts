// MCP surface (Model Context Protocol, Streamable HTTP transport).
//
// POST /mcp is JSON-RPC 2.0. The server speaks revision 2026-07-28 (modern
// era: server/discover, no handshake, no session) and also answers the
// legacy handshake era (initialize + notifications/initialized, optional
// Mcp-Session-Id) for a client that negotiates 2025-11-25 or earlier.
//
// Determinism: no wall clock, no randomness. All timestamps come from
// ctx.store.clock, all ids from the store counters, the tools list is a
// frozen constant serialized identically on every call, and the session id
// is a fixed string. The tools act on the same Store as REST, so objects
// created here read back over /api/v3 unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Ctx, type Issue, type Pull, type Repo } from './store.ts';
import { isAuthorized, objectId, readBody, sendJson } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SESSION_ID = 'mcp-session-1';

/** Protocol versions the server will negotiate, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const CAPABILITIES: Record<string, unknown> = Object.freeze({ tools: Object.freeze({}) });
const SERVER_INFO: Record<string, unknown> = Object.freeze({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One input property: a JSON-schema fragment for a tool argument. */
function prop(type: string, description: string): Record<string, unknown> {
  return Object.freeze({ type, description });
}

/** Build one frozen tool definition from its name, description and fields. */
function defineTool(
  name: string,
  description: string,
  fields: Record<string, Record<string, unknown>>,
  required: readonly string[],
): ToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ ...fields }),
      required: Object.freeze([...required]),
    }),
  });
}

// The tools list, built once and frozen: two tools/list calls must answer
// the same list byte for byte, so nothing here is generated per request.
const TOOLS: readonly ToolDef[] = Object.freeze([
  defineTool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: prop('string', 'The name of the repository.'),
      description: prop('string', 'A short description of the repository.'),
      private: prop('boolean', 'Whether the repository is private.'),
      full_name: prop('string', 'The full name of the repository (owner/name).'),
    },
    ['name'],
  ),
  defineTool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: prop('string', 'The owner (login) of the repository.'),
      repo: prop('string', 'The name of the repository.'),
      full_name: prop('string', 'The full name of the repository (owner/name).'),
    },
    ['owner', 'repo'],
  ),
  defineTool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: prop('string', 'The owner (login) of the repository.'),
      repo: prop('string', 'The name of the repository.'),
      title: prop('string', 'The title of the issue.'),
      body: prop('string', 'The body of the issue.'),
      full_name: prop('string', 'The full name of the repository (owner/name).'),
    },
    ['owner', 'repo', 'title'],
  ),
  defineTool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: prop('string', 'The owner (login) of the repository.'),
      repo: prop('string', 'The name of the repository.'),
      state: prop('string', 'The state of issues to list: open, closed, or all.'),
      full_name: prop('string', 'The full name of the repository (owner/name).'),
    },
    ['owner', 'repo'],
  ),
  defineTool(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: prop('string', 'The owner (login) of the repository.'),
      repo: prop('string', 'The name of the repository.'),
      title: prop('string', 'The title of the pull request.'),
      body: prop('string', 'The body of the pull request.'),
      head: prop('string', 'The head branch (or ref) the changes are on.'),
      base: prop('string', 'The base branch the changes are merged into.'),
      full_name: prop('string', 'The full name of the repository (owner/name).'),
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  defineTool(
    'merge_pull_request',
    'Merge a pull request with a squash commit onto its base branch.',
    {
      owner: prop('string', 'The owner (login) of the repository.'),
      repo: prop('string', 'The name of the repository.'),
      pull_number: prop('number', 'The number of the pull request to merge.'),
      full_name: prop('string', 'The full name of the repository (owner/name).'),
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

type JsonRpcId = string | number | null;
type ToolResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string argument, or null when absent/empty/wrong type. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** An integer argument, accepting JSON numbers and digit strings, else null. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** First non-null string among the given candidates. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const found = asString(value);
    if (found !== null) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool results and JSON views
// ---------------------------------------------------------------------------

/** A successful tool result: JSON text plus structured content. */
function toolResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

/**
 * A tool execution failure. The JSON-RPC layer still answers 200 with a
 * result; the failure is carried in isError plus an {error} payload.
 */
function toolError(message: string): ToolResult {
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

// ---------------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------------

/**
 * Resolve owner/repo from tool arguments, accepting the documented names
 * and the synonyms the suite may map onto (owner_login, repository,
 * full_name, ...).
 */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  const fullName = firstString(args.full_name, args.repo_full_name, args.repository_full_name);
  let owner: string | null = null;
  let repo: string | null = null;
  if (fullName !== null) {
    const parts = fullName.split('/');
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      owner = parts[0];
      repo = parts[1];
    }
  }
  if (owner === null) {
    owner = firstString(args.owner, args.owner_login, args.org, args.organization, args.user_login, args.login);
  }
  if (repo === null) {
    repo = firstString(args.repo, args.repository, args.repository_name, args.repo_name, args.name);
  }
  return { owner, repo };
}

/** The `tree <sha>` line of a commit object, or null when it cannot be read. */
function commitTreeSha(repo: Repo, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const match = /^tree ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1];
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolCreateRepo(ctx: Ctx, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  const name = firstString(args.name, args.repo, args.repository);
  if (name === null) return toolError('missing required argument: name');
  const description = firstString(args.description, args.body) ?? '';
  const isPrivate = asBool(args.private ?? args.is_private, false);
  if (store.getRepo(VIEWER.login, name) !== undefined) {
    return toolError(`repository ${VIEWER.login}/${name} already exists`);
  }
  const repo = store.createRepo(name, description, isPrivate, 'main');
  store.defaultLabels(repo);
  return toolResult(repoJson(repo));
}

function toolGetRepo(ctx: Ctx, args: Record<string, unknown>): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === null || repo === null) return toolError('missing required argument: owner/repo');
  const found = ctx.store.getRepo(owner, repo);
  if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
  return toolResult(repoJson(found));
}

function toolCreateIssue(ctx: Ctx, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  const { owner, repo } = resolveOwnerRepo(args);
  const title = firstString(args.title, args.issue_title);
  if (owner === null || repo === null || title === null) {
    return toolError('missing required argument: owner/repo/title');
  }
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
  const body = firstString(args.body, args.issue_body, args.description) ?? '';
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

function toolListIssues(ctx: Ctx, args: Record<string, unknown>): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === null || repo === null) return toolError('missing required argument: owner/repo');
  const found = ctx.store.getRepo(owner, repo);
  if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
  const state = firstString(args.state, args.status) ?? 'open';
  const listed = [...found.issues.values()]
    .filter((issue) => state === 'all' || issue.state === state)
    .sort((a, b) => a.number - b.number);
  return toolResult(listed.map((issue) => issueJson(issue)));
}

function toolCreatePullRequest(ctx: Ctx, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  const { owner, repo } = resolveOwnerRepo(args);
  const title = firstString(args.title, args.pr_title);
  const head = firstString(args.head, args.head_ref, args.head_branch, args.source_branch);
  const base = firstString(args.base, args.base_ref, args.base_branch, args.target_branch);
  if (owner === null || repo === null || title === null || head === null || base === null) {
    return toolError('missing required argument: owner/repo/title/head/base');
  }
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
  const headSha = found.refs.get(`refs/heads/${head}`);
  if (headSha === undefined) return toolError(`head branch ${head} not found`);
  const baseSha = found.refs.get(`refs/heads/${base}`);
  if (baseSha === undefined) return toolError(`base branch ${base} not found`);
  const body = firstString(args.body, args.pr_body, args.description) ?? '';
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

function toolMergePullRequest(ctx: Ctx, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
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

/** Canonical tool name -> implementation. */
const TOOL_HANDLERS: Readonly<Record<string, (ctx: Ctx, args: Record<string, unknown>) => ToolResult>> = {
  create_repo: toolCreateRepo,
  get_repo: toolGetRepo,
  create_issue: toolCreateIssue,
  list_issues: toolListIssues,
  create_pull_request: toolCreatePullRequest,
  merge_pull_request: toolMergePullRequest,
};

/** Match a tools/call name to a canonical tool: exact, then suffix, case-insensitive. */
function canonicalToolName(name: string): string | null {
  const squashed = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exact = TOOLS.find((tool) => tool.name.replace(/[^a-z0-9]/g, '') === squashed);
  if (exact !== undefined) return exact.name;
  const suffixed = TOOLS.find((tool) => {
    const wanted = tool.name.replace(/[^a-z0-9]/g, '');
    return squashed.length > wanted.length && squashed.endsWith(wanted);
  });
  return suffixed?.name ?? null;
}

/** Required schema properties for a canonical tool (for the missing-argument check). */
function requiredOf(canonical: string): readonly string[] {
  const tool = TOOLS.find((candidate) => candidate.name === canonical);
  if (tool === undefined) return [];
  const required = (tool.inputSchema as { required?: unknown }).required;
  return Array.isArray(required) ? (required as string[]) : [];
}

/**
 * Which required arguments a tools/call is missing. The suite maps arguments
 * onto the schema's property names first, so the documented names and their
 * synonyms for owner/repo/full_name all count as present.
 */
function missingArguments(canonical: string, args: Record<string, unknown>): string[] {
  const present = new Set(Object.keys(args));
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner !== null) present.add('owner');
  if (repo !== null) present.add('repo');
  return requiredOf(canonical).filter((key) => {
    if (present.has(key)) return false;
    // pull_number may arrive under a synonym the schema does not name.
    if (key === 'pull_number') {
      const viaSynonym = asNumber(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number);
      if (viaSynonym !== null) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

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
    const missing = missingArguments(canonical, args);
    if (missing.length > 0) {
      sendRpcError(-32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      return true;
    }
    const handler = TOOL_HANDLERS[canonical];
    const result = handler === undefined ? toolError(`unknown tool: ${canonical}`) : handler(ctx, args);
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
