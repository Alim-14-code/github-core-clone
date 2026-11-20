// REST v3 surface for the git forge (GitHub-compatible, /api/v3).
// Deterministic: all timestamps come from ctx.store.clock, all ids from
// store counters, git object ids are content hashes. No wall clock, no
// randomness.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Ctx, type Issue, type Label, type Pull, type Repo } from './store.ts';
import {
  decodeSegment,
  isAuthorized,
  nextRequestId,
  objectId,
  parseJsonBody,
  pathOf,
  queryOf,
  readBody,
  sendJson,
} from './util.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Response plumbing
// ---------------------------------------------------------------------------

function rid(ctx: Ctx): string {
  return nextRequestId(ctx.requestSeq);
}

/** Send a JSON body with the standard X-GitHub-Request-Id header. */
function send(
  res: ServerResponse,
  ctx: Ctx,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  sendJson(res, status, body, { 'x-github-request-id': rid(ctx), ...extra });
}

/** Send a `{message}` error body. */
function fail(
  res: ServerResponse,
  ctx: Ctx,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  send(res, ctx, status, { message }, extra);
}

/** Send an empty 204 with the standard request-id header. */
function noContent(res: ServerResponse, ctx: Ctx): void {
  res.writeHead(204, { 'x-github-request-id': rid(ctx) });
  res.end();
}

function isoOfUnix(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** The parsed JSON body as an object, or null when it is not one. */
function bodyObject(body: unknown): Json | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Json;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** The viewer is the only user that ever exists; its JSON never changes. */
const userJsonCache = new Map<string, Json>();

/** R5: node_ids are pure functions of (prefix, id); memoize the base64. */
const nodeIdCache = new Map<string, string>();

function nodeId(prefix: string, id: string | number): string {
  const key = `${prefix}:${id}`;
  const cached = nodeIdCache.get(key);
  if (cached !== undefined) return cached;
  const built = Buffer.from(`${prefix}${id}`).toString('base64');
  nodeIdCache.set(key, built);
  return built;
}

function userJson(login: string, id: number): Json {
  const key = `${login}:${id}`;
  const cached = userJsonCache.get(key);
  if (cached !== undefined) return cached;
  const built: Json = {
    login,
    id,
    node_id: Buffer.from(`04:User${id}`).toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
  userJsonCache.set(key, built);
  return built;
}

function repoJson(r: Repo): Json {
  const openIssues = [...r.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: r.id,
    node_id: Buffer.from(`010:Repository${r.id}`).toString('base64'),
    name: r.name,
    full_name: r.full_name,
    owner: userJson(r.owner, VIEWER.id),
    private: r.private,
    html_url: r.html_url,
    description: r.description,
    fork: r.fork,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    git_url: `git://github.com/${r.full_name}.git`,
    ssh_url: `git@github.com:${r.full_name}.git`,
    clone_url: `https://github.com/${r.full_name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: r.private ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: r.default_branch,
  };
}

function labelJson(l: Label): Json {
  return {
    id: l.id,
    node_id: Buffer.from(`07:Label${l.id}`).toString('base64'),
    url: l.url,
    name: l.name,
    color: l.color,
    default: false,
    description: l.description,
  };
}

function issueJson(r: Repo, i: Issue): Json {
  return {
    id: i.id,
    node_id: nodeId('01:Issue', i.id),
    url: i.url,
    repository_url: r.url,
    labels_url: `${r.url}/labels{/name}`,
    comments_url: i.comments_url,
    events_url: `${i.url}/events`,
    html_url: i.html_url,
    number: i.number,
    state: i.state,
    title: i.title,
    body: i.body,
    user: userJson(i.user.login, i.user.id),
    labels: i.labels.map(labelJson),
    assignee: i.assignee,
    locked: i.locked,
    comments: i.comments.length,
    closed_at: i.closed_at,
    created_at: i.created_at,
    updated_at: i.updated_at,
    author_association: 'OWNER',
    state_reason: i.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(
  r: Repo,
  issue: Issue,
  c: { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string; html_url: string; url: string },
): Json {
  return {
    id: c.id,
    node_id: Buffer.from(`04:IssueComment${c.id}`).toString('base64'),
    url: c.url,
    html_url: c.html_url,
    body: c.body,
    user: userJson(c.user.login, c.user.id),
    created_at: c.created_at,
    updated_at: c.updated_at,
    issue_url: `${r.url}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function pullRepoJson(r: Repo, ref: { id: number; full_name: string } | null): Json | null {
  if (ref === null) return null;
  return {
    id: ref.id,
    node_id: Buffer.from(`010:Repository${ref.id}`).toString('base64'),
    name: r.name,
    full_name: ref.full_name,
    private: r.private,
    owner: userJson(r.owner, VIEWER.id),
  };
}

function pullJson(r: Repo, p: Pull, mergeable: boolean | null): Json {
  return {
    id: p.id,
    node_id: Buffer.from(`02:PullRequest${p.id}`).toString('base64'),
    url: p.url,
    html_url: p.html_url,
    diff_url: `${p.html_url}.diff`,
    patch_url: `${p.html_url}.patch`,
    issue_url: `${r.url}/issues/${p.number}`,
    number: p.number,
    state: p.state,
    locked: false,
    title: p.title,
    user: userJson(p.user.login, p.user.id),
    body: p.body,
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${p.url}/commits`,
    review_comments_url: `${p.url}/comments`,
    review_comment_url: `${r.url}/pulls/comments{/number}`,
    comments_url: `${p.url}/comments`,
    statuses_url: `${r.url}/commits/${p.head.sha}/statuses`,
    head: {
      label: p.head.label,
      ref: p.head.ref,
      sha: p.head.sha,
      user: userJson(r.owner, VIEWER.id),
      repo: pullRepoJson(r, p.head.repo),
    },
    base: {
      label: p.base.label,
      ref: p.base.ref,
      sha: p.base.sha,
      user: userJson(r.owner, VIEWER.id),
      repo: pullRepoJson(r, p.base.repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: p.merged,
    mergeable,
    rebaseable: mergeable,
    mergeable_state: mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown',
    merged_by: p.merged ? userJson(VIEWER.login, VIEWER.id) : null,
  };
}

function commitJson(repo: Repo, sha: string, c: ParsedCommit): Json {
  const author = { name: c.authorName, email: c.authorEmail, date: isoOfUnix(c.authorTs) };
  const committer = { name: c.committerName, email: c.committerEmail, date: isoOfUnix(c.committerTs) };
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: Buffer.from(`04:Commit${sha}`).toString('base64'),
    commit: {
      author,
      committer,
      message: c.message,
      tree: { sha: c.tree, url: `${base}/git/trees/${c.tree}` },
      url: `${base}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${base}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${base}/commits/${sha}/comments`,
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: c.parents.map((p) => ({
      sha: p,
      url: `${base}/commits/${p}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const rawPer = parseInt(q.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(rawPer) && rawPer > 0 ? rawPer : 30));
  return { page, perPage };
}

function paginate<T>(
  req: IncomingMessage,
  q: URLSearchParams,
  items: readonly T[],
): { items: T[]; link: string | null } {
  const { page, perPage } = pageParams(q);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  if (page >= totalPages) return { items: pageItems, link: null };
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${pathOf(req)}`;
  const mk = (p: number): string => {
    const params = new URLSearchParams(q);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  return { items: pageItems, link: `<${mk(page + 1)}>; rel="next", <${mk(totalPages)}>; rel="last"` };
}

function sendPage<T>(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  items: readonly T[],
  toJson: (item: T) => unknown,
): void {
  const q = queryOf(req);
  const { items: pageItems, link } = paginate(req, q, items);
  const extra: Record<string, string> = {};
  if (link !== null) extra.link = link;
  send(res, ctx, 200, pageItems.map(toJson), extra);
}

// ---------------------------------------------------------------------------
// Git object helpers (repo.objects is the loose store)
// ---------------------------------------------------------------------------

interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}

function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTs: 0,
    committerName: '',
    committerEmail: '',
    committerTs: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const isAuthor = line.startsWith('author ');
      const rest = line.slice(isAuthor ? 7 : 10);
      const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(rest);
      if (m === null) continue;
      const name = m[1] ?? '';
      const email = m[2] ?? '';
      const ts = parseInt(m[3] ?? '0', 10) || 0;
      if (isAuthor) {
        out.authorName = name;
        out.authorEmail = email;
        out.authorTs = ts;
      } else {
        out.committerName = name;
        out.committerEmail = email;
        out.committerTs = ts;
      }
    }
  }
  return out.tree === '' ? null : out;
}

function getCommit(repo: Repo, sha: string): ParsedCommit | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

function storeObject(repo: Repo, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const sha = objectId(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp);
    if (nul === -1 || nul + 21 > data.length) break;
    out.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

/** Flatten a tree (by sha) to path -> blob sha. */
function flattenTree(repo: Repo, treeSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const pending: Array<{ sha: string; prefix: string }> = [{ sha: treeSha, prefix: '' }];
  while (pending.length > 0) {
    const cur = pending.pop();
    if (cur === undefined) break;
    const obj = repo.objects.get(cur.sha);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const e of parseTree(obj.data)) {
      const p = cur.prefix === '' ? e.name : `${cur.prefix}/${e.name}`;
      if (e.mode === '40000') pending.push({ sha: e.sha, prefix: p });
      else out.set(p, e.sha);
    }
  }
  return out;
}

/** Build nested trees from a path -> blob sha map; stores trees; returns root tree sha. */
function buildTree(repo: Repo, files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const seenDirs = new Set<string>();
    const entries: TreeEntry[] = [];
    for (const [path, sha] of files) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: rest, sha });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ mode: '40000', name: dir, sha: '' });
        }
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const parts: Buffer[] = [];
    for (const e of entries) {
      const childPrefix = prefix === '' ? `${e.name}/` : `${prefix}${e.name}/`;
      const sha = e.mode === '40000' ? build(childPrefix) : e.sha;
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(sha, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(parts));
  };
  return build('');
}

function createCommitObject(
  repo: Repo,
  ctx: Ctx,
  treeSha: string,
  parents: string[],
  message: string,
): { sha: string; ts: number } {
  const ts = ctx.store.clock.tickUnix();
  const who = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  let text = `tree ${treeSha}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}\n`;
  const sha = storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
  return { sha, ts };
}

/** Resolve a ref-ish (branch name, full ref, or sha) to a commit sha, or null. */
function resolveRef(repo: Repo, refish: string): string | null {
  if (repo.refs.has(refish)) return repo.refs.get(refish) ?? null;
  const head = repo.refs.get(`refs/heads/${refish}`);
  if (head !== undefined) return head;
  const tag = repo.refs.get(`refs/tags/${refish}`);
  if (tag !== undefined) return tag;
  if (/^[0-9a-f]{40}$/i.test(refish)) {
    const lower = refish.toLowerCase();
    const obj = repo.objects.get(lower);
    if (obj !== undefined && (obj.type === 'commit' || obj.type === 'tag')) return lower;
  }
  return null;
}

/** Ancestor shas of `start`, newest-first (DFS pre-order, first-parent first), deduped. */
function ancestors(repo: Repo, start: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [start];
  while (stack.length > 0) {
    const sha = stack.pop();
    if (sha === undefined || seen.has(sha)) continue;
    seen.add(sha);
    const c = getCommit(repo, sha);
    if (c === null) continue;
    out.push(sha);
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i] as string);
  }
  return out;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAnc = new Set(ancestors(repo, b));
  for (const sha of ancestors(repo, a)) {
    if (bAnc.has(sha)) return sha;
  }
  return null;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function blobLines(repo: Repo, sha: string | null): string[] {
  if (sha === null) return [];
  const obj = repo.objects.get(sha);
  if (obj === undefined) return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLineDiff(
  repo: Repo,
  oldSha: string | null,
  newSha: string | null,
): { additions: number; deletions: number } {
  const oldLines = blobLines(repo, oldSha);
  const newLines = blobLines(repo, newSha);
  const remaining = new Map<string, number>();
  for (const l of oldLines) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const left = remaining.get(l) ?? 0;
    if (left > 0) remaining.set(l, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of remaining.values()) deletions += left;
  return { additions, deletions };
}

function diffFileMaps(repo: Repo, oldMap: Map<string, string>, newMap: Map<string, string>): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
  for (const path of [...paths].sort()) {
    const o = oldMap.get(path) ?? null;
    const n = newMap.get(path) ?? null;
    if (o === n) continue;
    if (o === null && n !== null) {
      const lines = blobLines(repo, n).length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (n === null && o !== null) {
      const lines = blobLines(repo, o).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else {
      const { additions, deletions } = countLineDiff(repo, o, n);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repo lookup (owner must be the viewer; any other owner is 404, never 403)
// ---------------------------------------------------------------------------

function lookupRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

// ---------------------------------------------------------------------------
// Request context shared by the section handlers
// ---------------------------------------------------------------------------

interface Req {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: Ctx;
  method: string;
  segs: string[];
  q: URLSearchParams;
  body: unknown;
}

function notFound(r: Req): void {
  fail(r.res, r.ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Top-level routes: /api/v3, /api/v3/meta, /api/v3/user[/repos]
// ---------------------------------------------------------------------------

function handleRoot(r: Req): boolean {
  if (r.method !== 'GET') {
    notFound(r);
    return true;
  }
  send(
    r.res,
    r.ctx,
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
  return true;
}

function handleMeta(r: Req): boolean {
  if (r.method !== 'GET') {
    notFound(r);
    return true;
  }
  send(r.res, r.ctx, 200, {
    verifiable_password_authentication: true,
    ssh_key_fingerprints: {},
    ssh_keys: [],
    hooks: [],
    web: [],
    api: [],
    git: [],
    packages: [],
    pages: [],
    importer: [],
    actions: [],
    dependabot: [],
    installed_version: '1.0.0',
  });
  return true;
}

function handleUser(r: Req): boolean {
  const store = r.ctx.store;
  if (r.segs.length === 1) {
    if (r.method !== 'GET') {
      notFound(r);
      return true;
    }
    send(r.res, r.ctx, 200, {
      ...userJson(VIEWER.login, VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      company: null,
      blog: '',
      location: null,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: store.viewerRepos().length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: '2026-11-14T06:30:00.000Z',
      updated_at: store.clock.nowIso(),
    });
    return true;
  }
  if (r.segs.length === 2 && r.segs[1] === 'repos') {
    if (r.method === 'GET') {
      sendPage(r.req, r.res, r.ctx, store.viewerRepos(), (repo) => repoJson(repo));
      return true;
    }
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const name = b === null ? null : str(b.name);
      if (name === null || name === '') {
        fail(r.res, r.ctx, 422, 'Validation Failed: name is required');
        return true;
      }
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        fail(r.res, r.ctx, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const isPrivate = b !== null && b.private === true;
      const description = b !== null && typeof b.description === 'string' ? b.description : '';
      const defaultBranch =
        b !== null && typeof b.default_branch === 'string' && b.default_branch !== ''
          ? b.default_branch
          : 'main';
      const repo = store.createRepo(name, description, isPrivate, defaultBranch);
      store.defaultLabels(repo);
      send(r.res, r.ctx, 201, repoJson(repo));
      return true;
    }
    notFound(r);
    return true;
  }
  notFound(r);
  return true;
}

// ---------------------------------------------------------------------------
// /api/v3/repos/{owner}/{repo}[...]
// ---------------------------------------------------------------------------

interface RepoReq extends Req {
  repo: Repo;
  owner: string;
  repoName: string;
  tail: string[];
}

function handleRepoRoot(r: RepoReq): boolean {
  const store = r.ctx.store;
  const repo = r.repo;
  if (r.method === 'GET') {
    send(r.res, r.ctx, 200, repoJson(repo));
    return true;
  }
  if (r.method === 'PATCH') {
    const b = bodyObject(r.body);
    if (b === null) {
      fail(r.res, r.ctx, 400, 'Problems parsing JSON');
      return true;
    }
    if (typeof b.description === 'string') repo.description = b.description;
    if (b.private === true || b.private === false) repo.private = b.private;
    if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.default_branch = b.default_branch;
    if (typeof b.name === 'string' && b.name !== '' && b.name !== repo.name) {
      if (store.getRepo(r.owner, b.name) !== undefined) {
        fail(r.res, r.ctx, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      store.repos.delete(store.repoKey(r.owner, repo.name));
      repo.name = b.name;
      repo.full_name = `${r.owner}/${b.name}`;
      repo.html_url = `https://github.com/${r.owner}/${b.name}`;
      repo.url = `/api/v3/repos/${r.owner}/${b.name}`;
      store.repos.set(store.repoKey(r.owner, repo.name), repo);
    }
    repo.updated_at = store.clock.tickIso();
    send(r.res, r.ctx, 200, repoJson(repo));
    return true;
  }
  if (r.method === 'DELETE') {
    store.deleteRepo(r.owner, r.repoName);
    noContent(r.res, r.ctx);
    return true;
  }
  notFound(r);
  return true;
}

function branchJson(owner: string, repoName: string, name: string, sha: string): Json {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
    protected: false,
  };
}

function handleBranches(r: RepoReq): boolean {
  const repo = r.repo;
  const tail = r.tail;
  if (tail.length === 1) {
    if (r.method !== 'GET') {
      notFound(r);
      return true;
    }
    const list: Json[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      list.push(branchJson(r.owner, r.repoName, ref.slice('refs/heads/'.length), sha));
    }
    sendPage(r.req, r.res, r.ctx, list, (x) => x);
    return true;
  }
  const branch = tail.slice(1).join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (r.method === 'GET') {
    if (sha === undefined) {
      notFound(r);
      return true;
    }
    send(r.res, r.ctx, 200, branchJson(r.owner, r.repoName, branch, sha));
    return true;
  }
  if (r.method === 'DELETE') {
    if (sha === undefined) {
      notFound(r);
      return true;
    }
    repo.refs.delete(`refs/heads/${branch}`);
    noContent(r.res, r.ctx);
    return true;
  }
  notFound(r);
  return true;
}

function handleCommits(r: RepoReq): boolean {
  const repo = r.repo;
  const tail = r.tail;
  if (tail.length === 1) {
    if (r.method !== 'GET') {
      notFound(r);
      return true;
    }
    const refish = r.q.get('sha') ?? repo.default_branch;
    const tip = resolveRef(repo, refish);
    if (tip === null) {
      notFound(r);
      return true;
    }
    const pathFilter = r.q.get('path');
    const items: Json[] = [];
    for (const sha of ancestors(repo, tip)) {
      const c = getCommit(repo, sha);
      if (c === null) continue;
      if (pathFilter !== null) {
        const tree = flattenTree(repo, c.tree);
        const parent = c.parents.length > 0 ? getCommit(repo, c.parents[0] as string) : null;
        const parentTree = parent === null ? new Map<string, string>() : flattenTree(repo, parent.tree);
        if (tree.get(pathFilter) === parentTree.get(pathFilter)) continue;
      }
      items.push(commitJson(repo, sha, c));
    }
    sendPage(r.req, r.res, r.ctx, items, (x) => x);
    return true;
  }
  const sha = tail.slice(1).join('/');
  if (r.method === 'GET') {
    const c = getCommit(repo, sha);
    if (c === null) {
      notFound(r);
      return true;
    }
    send(r.res, r.ctx, 200, commitJson(repo, sha.toLowerCase(), c));
    return true;
  }
  notFound(r);
  return true;
}

function refJson(owner: string, repoName: string, ref: string, sha: string): Json {
  return {
    ref,
    node_id: Buffer.from(`04:Ref${ref}`).toString('base64'),
    url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: {
      sha,
      type: 'commit',
      url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}`,
    },
  };
}

function handleGitRefs(r: RepoReq): boolean {
  const repo = r.repo;
  const tail = r.tail;
  if (tail.length === 2) {
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const ref = b === null ? null : str(b.ref);
      const sha = b === null ? null : str(b.sha);
      if (
        ref === null ||
        sha === null ||
        (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))
      ) {
        fail(r.res, r.ctx, 422, 'Validation Failed: ref and sha are required');
        return true;
      }
      if (repo.refs.has(ref)) {
        fail(r.res, r.ctx, 422, 'Validation Failed: ref already exists');
        return true;
      }
      if (repo.objects.get(sha) === undefined) {
        fail(r.res, r.ctx, 422, 'Validation Failed: sha does not exist');
        return true;
      }
      repo.refs.set(ref, sha);
      send(r.res, r.ctx, 201, refJson(r.owner, r.repoName, ref, sha));
      return true;
    }
    if (r.method === 'GET') {
      const list: Json[] = [];
      for (const [ref, sha] of repo.refs) list.push(refJson(r.owner, r.repoName, ref, sha));
      sendPage(r.req, r.res, r.ctx, list, (x) => x);
      return true;
    }
    notFound(r);
    return true;
  }
  const refName = `refs/${tail.slice(2).join('/')}`;
  const sha = repo.refs.get(refName);
  if (r.method === 'GET') {
    if (sha === undefined) {
      notFound(r);
      return true;
    }
    send(r.res, r.ctx, 200, refJson(r.owner, r.repoName, refName, sha));
    return true;
  }
  if (r.method === 'PATCH') {
    if (sha === undefined) {
      notFound(r);
      return true;
    }
    const b = bodyObject(r.body);
    const newSha = b === null ? null : str(b.sha);
    if (newSha === null || repo.objects.get(newSha) === undefined) {
      fail(r.res, r.ctx, 422, 'Validation Failed: sha does not exist');
      return true;
    }
    repo.refs.set(refName, newSha);
    send(r.res, r.ctx, 200, refJson(r.owner, r.repoName, refName, newSha));
    return true;
  }
  if (r.method === 'DELETE') {
    if (sha === undefined) {
      notFound(r);
      return true;
    }
    repo.refs.delete(refName);
    noContent(r.res, r.ctx);
    return true;
  }
  notFound(r);
  return true;
}

function handleGitCommit(r: RepoReq): boolean {
  const repo = r.repo;
  const tail = r.tail;
  if (r.method !== 'GET') {
    notFound(r);
    return true;
  }
  const sha = tail[2] as string;
  const c = getCommit(repo, sha);
  if (c === null) {
    notFound(r);
    return true;
  }
  const base = `/api/v3/repos/${r.owner}/${r.repoName}`;
  send(r.res, r.ctx, 200, {
    sha: sha.toLowerCase(),
    node_id: Buffer.from(`04:Commit${sha}`).toString('base64'),
    url: `${base}/git/commits/${sha}`,
    html_url: `https://github.com/${r.owner}/${r.repoName}/commit/${sha}`,
    author: { name: c.authorName, email: c.authorEmail, date: isoOfUnix(c.authorTs) },
    committer: { name: c.committerName, email: c.committerEmail, date: isoOfUnix(c.committerTs) },
    tree: { sha: c.tree, url: `${base}/git/trees/${c.tree}` },
    message: c.message,
    parents: c.parents.map((p) => ({
      sha: p,
      url: `${base}/git/commits/${p}`,
      html_url: `https://github.com/${r.owner}/${r.repoName}/commit/${p}`,
    })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function contentEntry(
  owner: string,
  repoName: string,
  ref: string,
  filePath: string,
  blobSha: string,
  size: number,
  content: string,
): Json {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const base = `/api/v3/repos/${owner}/${repoName}`;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path: filePath,
    content,
    sha: blobSha,
    url: `${base}/contents/${filePath}`,
    git_url: `${base}/git/blobs/${blobSha}`,
    html_url: `https://github.com/${owner}/${repoName}/blob/${ref}/${filePath}`,
    download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${ref}/${filePath}`,
    _links: {
      git: `${base}/git/blobs/${blobSha}`,
      self: `${base}/contents/${filePath}`,
      html: `https://github.com/${owner}/${repoName}/blob/${ref}/${filePath}`,
    },
  };
}

function commitSummary(
  owner: string,
  repoName: string,
  commitSha: string,
  treeSha: string,
  message: string,
  now: string,
  parents: string[],
): Json {
  const base = `/api/v3/repos/${owner}/${repoName}`;
  return {
    sha: commitSha,
    node_id: Buffer.from(`04:Commit${commitSha}`).toString('base64'),
    url: `${base}/commits/${commitSha}`,
    html_url: `https://github.com/${owner}/${repoName}/commit/${commitSha}`,
    author: { name: VIEWER.name, email: VIEWER.email, date: now },
    committer: { name: VIEWER.name, email: VIEWER.email, date: now },
    message,
    tree: { sha: treeSha, url: `${base}/git/trees/${treeSha}` },
    parents: parents.map((p) => ({
      sha: p,
      url: `${base}/commits/${p}`,
      html_url: `https://github.com/${owner}/${repoName}/commit/${p}`,
    })),
  };
}

function handleContents(r: RepoReq): boolean {
  const repo = r.repo;
  const store = r.ctx.store;
  const tail = r.tail;
  const filePath = tail.slice(1).join('/');

  if (r.method === 'GET') {
    const refish = r.q.get('ref') ?? repo.default_branch;
    const tip = resolveRef(repo, refish);
    if (tip === null) {
      notFound(r);
      return true;
    }
    const commit = getCommit(repo, tip);
    if (commit === null) {
      notFound(r);
      return true;
    }
    const treeMap = flattenTree(repo, commit.tree);
    if (filePath === '') {
      send(r.res, r.ctx, 200, dirListing(repo, commit.tree, '', r.owner, r.repoName));
      return true;
    }
    const blobSha = treeMap.get(filePath);
    if (blobSha !== undefined) {
      const obj = repo.objects.get(blobSha);
      const size = obj === undefined ? 0 : obj.data.length;
      send(
        r.res,
        r.ctx,
        200,
        contentEntry(r.owner, r.repoName, refish, filePath, blobSha, size, obj === undefined ? '' : b64encode(obj.data)),
      );
      return true;
    }
    const prefix = `${filePath}/`;
    let isDir = false;
    for (const p of treeMap.keys()) {
      if (p.startsWith(prefix)) {
        isDir = true;
        break;
      }
    }
    if (isDir) {
      send(r.res, r.ctx, 200, dirListing(repo, commit.tree, filePath, r.owner, r.repoName));
      return true;
    }
    notFound(r);
    return true;
  }

  if (r.method === 'PUT') {
    const b = bodyObject(r.body);
    if (b === null) {
      fail(r.res, r.ctx, 400, 'Problems parsing JSON');
      return true;
    }
    const contentB64 = str(b.content);
    if (contentB64 === null) {
      fail(r.res, r.ctx, 422, 'Validation Failed: content is required');
      return true;
    }
    const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.default_branch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined && repo.refs.size > 0) {
      notFound(r);
      return true;
    }
    const baseCommit = tip === undefined ? null : getCommit(repo, tip);
    const treeMap = baseCommit === null ? new Map<string, string>() : flattenTree(repo, baseCommit.tree);
    const existingSha = treeMap.get(filePath);
    const givenSha = str(b.sha);
    if (givenSha !== null) {
      const mismatch =
        existingSha === undefined || givenSha.toLowerCase() !== existingSha.toLowerCase();
      if (mismatch) {
        fail(r.res, r.ctx, 409, 'Conflict: sha does not match the current file');
        return true;
      }
    }
    const isCreate = existingSha === undefined;
    const contentBuf = b64decode(contentB64);
    const blobSha = storeObject(repo, 'blob', contentBuf);
    treeMap.set(filePath, blobSha);
    const treeSha = buildTree(repo, treeMap);
    const message =
      typeof b.message === 'string' && b.message !== ''
        ? b.message
        : isCreate
          ? `Create ${filePath}`
          : `Update ${filePath}`;
    const parents = tip === undefined ? [] : [tip];
    const { sha: commitSha } = createCommitObject(repo, r.ctx, treeSha, parents, message);
    repo.refs.set(refName, commitSha);
    const now = store.clock.nowIso();
    repo.pushed_at = now;
    repo.updated_at = now;
    send(r.res, r.ctx, isCreate ? 201 : 200, {
      content: contentEntry(r.owner, r.repoName, branch, filePath, blobSha, contentBuf.length, b64encode(contentBuf)),
      commit: commitSummary(r.owner, r.repoName, commitSha, treeSha, message, now, parents),
    });
    return true;
  }

  if (r.method === 'DELETE') {
    const b = bodyObject(r.body);
    const branch =
      b !== null && typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.default_branch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) {
      notFound(r);
      return true;
    }
    const baseCommit = getCommit(repo, tip);
    if (baseCommit === null) {
      notFound(r);
      return true;
    }
    const treeMap = flattenTree(repo, baseCommit.tree);
    const existingSha = treeMap.get(filePath);
    if (existingSha === undefined) {
      notFound(r);
      return true;
    }
    const givenSha = b === null ? null : str(b.sha);
    if (givenSha !== null && givenSha.toLowerCase() !== existingSha.toLowerCase()) {
      fail(r.res, r.ctx, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    treeMap.delete(filePath);
    const treeSha = buildTree(repo, treeMap);
    const message =
      b !== null && typeof b.message === 'string' && b.message !== '' ? b.message : `Delete ${filePath}`;
    const { sha: commitSha } = createCommitObject(repo, r.ctx, treeSha, [tip], message);
    repo.refs.set(refName, commitSha);
    const now = store.clock.nowIso();
    repo.pushed_at = now;
    repo.updated_at = now;
    send(r.res, r.ctx, 200, {
      content: null,
      commit: commitSummary(r.owner, r.repoName, commitSha, treeSha, message, now, [tip]),
    });
    return true;
  }

  notFound(r);
  return true;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function handleLabels(r: RepoReq): boolean {
  const repo = r.repo;
  const tail = r.tail;
  if (tail.length === 1) {
    if (r.method === 'GET') {
      sendPage(r.req, r.res, r.ctx, [...repo.labels.values()], (l) => labelJson(l));
      return true;
    }
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const name = b === null ? null : str(b.name);
      if (name === null || name === '') {
        fail(r.res, r.ctx, 422, 'Validation Failed: name is required');
        return true;
      }
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        send(r.res, r.ctx, 201, labelJson(existing));
        return true;
      }
      const color = b !== null && typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
      const description = b !== null && typeof b.description === 'string' ? b.description : '';
      const label: Label = {
        id: repo.nextLabelId++,
        name,
        color,
        description,
        url: `/api/v3/repos/${r.owner}/${r.repoName}/labels/${encodeURIComponent(name)}`,
      };
      repo.labels.set(name, label);
      send(r.res, r.ctx, 201, labelJson(label));
      return true;
    }
    notFound(r);
    return true;
  }
  const labelName = tail.slice(1).join('/');
  const label = repo.labels.get(labelName);
  if (r.method === 'GET') {
    if (label === undefined) {
      notFound(r);
      return true;
    }
    send(r.res, r.ctx, 200, labelJson(label));
    return true;
  }
  if (r.method === 'PATCH') {
    if (label === undefined) {
      notFound(r);
      return true;
    }
    const b = bodyObject(r.body);
    if (b !== null) {
      if (typeof b.color === 'string') label.color = b.color.replace(/^#/, '');
      if (typeof b.description === 'string') label.description = b.description;
      if (typeof b.new_name === 'string' && b.new_name !== '' && b.new_name !== label.name) {
        repo.labels.delete(label.name);
        label.name = b.new_name;
        label.url = `/api/v3/repos/${r.owner}/${r.repoName}/labels/${encodeURIComponent(label.name)}`;
        repo.labels.set(label.name, label);
      }
    }
    send(r.res, r.ctx, 200, labelJson(label));
    return true;
  }
  if (r.method === 'DELETE') {
    if (label === undefined) {
      notFound(r);
      return true;
    }
    repo.labels.delete(labelName);
    noContent(r.res, r.ctx);
    return true;
  }
  notFound(r);
  return true;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** Issue label resolution: body.labels may be strings or {name} objects. */
function resolveIssueLabels(repo: Repo, b: Json | null): Label[] | null {
  if (b === null || b.labels === undefined) return [];
  if (!Array.isArray(b.labels)) return null;
  const out: Label[] = [];
  for (const item of b.labels) {
    const name =
      typeof item === 'string'
        ? item
        : typeof item === 'object' && item !== null
          ? str((item as Json).name)
          : null;
    if (name === null) return null;
    const label =
      repo.labels.get(name) ??
      [...repo.labels.values()].find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (label === undefined) return null;
    out.push(label);
  }
  return out;
}

function handleIssues(r: RepoReq): boolean {
  const repo = r.repo;
  const store = r.ctx.store;
  const tail = r.tail;
  if (tail.length === 1) {
    if (r.method === 'GET') {
      let list = [...repo.issues.values()];
      const state = r.q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const sort = r.q.get('sort') ?? 'created';
      const direction = r.q.get('direction') ?? 'desc';
      const dir = direction === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        let cmp = 0;
        if (sort === 'updated') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
        else if (sort === 'comments') cmp = a.comments.length - b.comments.length;
        else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
        if (cmp === 0) cmp = a.number - b.number;
        return cmp * dir;
      });
      sendPage(r.req, r.res, r.ctx, list, (i) => issueJson(repo, i));
      return true;
    }
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const title = b === null ? null : str(b.title);
      if (title === null || title === '') {
        fail(r.res, r.ctx, 422, 'Validation Failed: title is required');
        return true;
      }
      const labels = resolveIssueLabels(repo, b);
      if (labels === null) {
        fail(r.res, r.ctx, 422, 'Validation Failed: label does not exist');
        return true;
      }
      const now = store.clock.tickIso();
      const number = repo.nextIssueNumber++;
      const issue: Issue = {
        id: store.nextGlobalId(),
        number,
        title,
        body: b !== null && typeof b.body === 'string' ? b.body : '',
        state: 'open',
        labels,
        comments: [],
        user: VIEWER,
        assignee: null,
        milestone: null,
        locked: false,
        created_at: now,
        updated_at: now,
        closed_at: null,
        html_url: `https://github.com/${r.owner}/${r.repoName}/issues/${number}`,
        url: `/api/v3/repos/${r.owner}/${r.repoName}/issues/${number}`,
        comments_url: `/api/v3/repos/${r.owner}/${r.repoName}/issues/${number}/comments`,
      };
      repo.issues.set(number, issue);
      send(r.res, r.ctx, 201, issueJson(repo, issue));
      return true;
    }
    notFound(r);
    return true;
  }
  const num = parseInt(tail[1] as string, 10);
  if (!Number.isInteger(num)) {
    notFound(r);
    return true;
  }
  const issue = repo.issues.get(num);
  if (tail.length === 2) {
    if (r.method === 'GET') {
      if (issue === undefined) {
        notFound(r);
        return true;
      }
      send(r.res, r.ctx, 200, issueJson(repo, issue));
      return true;
    }
    if (r.method === 'PATCH') {
      if (issue === undefined) {
        notFound(r);
        return true;
      }
      const b = bodyObject(r.body);
      if (b === null) {
        fail(r.res, r.ctx, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (b.state === 'open' || b.state === 'closed') {
        issue.state = b.state;
        issue.closed_at = b.state === 'closed' ? store.clock.nowIso() : null;
      }
      if (b.labels !== undefined) {
        const labels = resolveIssueLabels(repo, b);
        if (labels === null) {
          fail(r.res, r.ctx, 422, 'Validation Failed: label does not exist');
          return true;
        }
        issue.labels = labels;
      }
      issue.updated_at = store.clock.tickIso();
      if (issue.state === 'closed' && issue.closed_at === null) issue.closed_at = issue.updated_at;
      send(r.res, r.ctx, 200, issueJson(repo, issue));
      return true;
    }
    notFound(r);
    return true;
  }
  if (tail.length === 3 && tail[2] === 'comments') {
    if (issue === undefined) {
      notFound(r);
      return true;
    }
    if (r.method === 'GET') {
      sendPage(r.req, r.res, r.ctx, issue.comments, (c) => commentJson(repo, issue, c));
      return true;
    }
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const cbody = b === null ? null : str(b.body);
      if (cbody === null) {
        fail(r.res, r.ctx, 422, 'Validation Failed: body is required');
        return true;
      }
      const now = store.clock.tickIso();
      const id = repo.nextCommentId++;
      const comment = {
        id,
        body: cbody,
        user: VIEWER,
        created_at: now,
        updated_at: now,
        html_url: `https://github.com/${r.owner}/${r.repoName}/issues/${num}#issuecomment-${id}`,
        url: `/api/v3/repos/${r.owner}/${r.repoName}/issues/comments/${id}`,
      };
      issue.comments.push(comment);
      issue.updated_at = store.clock.nowIso();
      send(r.res, r.ctx, 201, commentJson(repo, issue, comment));
      return true;
    }
    notFound(r);
    return true;
  }
  if (tail.length === 3 && tail[2] === 'labels') {
    if (issue === undefined) {
      notFound(r);
      return true;
    }
    if (r.method === 'GET') {
      send(r.res, r.ctx, 200, issue.labels.map(labelJson));
      return true;
    }
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const labels = resolveIssueLabels(repo, b);
      if (labels === null) {
        fail(r.res, r.ctx, 422, 'Validation Failed: label does not exist');
        return true;
      }
      for (const l of labels) {
        if (!issue.labels.some((x) => x.name === l.name)) issue.labels.push(l);
      }
      issue.updated_at = store.clock.tickIso();
      send(r.res, r.ctx, 200, issue.labels.map(labelJson));
      return true;
    }
    if (r.method === 'DELETE') {
      issue.labels = [];
      issue.updated_at = store.clock.tickIso();
      send(r.res, r.ctx, 200, []);
      return true;
    }
    notFound(r);
    return true;
  }
  notFound(r);
  return true;
}

// ---------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------

/**
 * Pull mergeability / files, computed from the object store (no side state,
 * so pulls created over git/GraphQL/MCP merge the same way).
 */
function pullMergeable(repo: Repo, pull: Pull): boolean | null {
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headCommit = getCommit(repo, headSha);
  const baseCommit = getCommit(repo, baseSha);
  if (headCommit === null || baseCommit === null) return null;
  if (headSha === baseSha) return true;
  const mb = mergeBase(repo, headSha, baseSha);
  if (mb === null) return false;
  const mbCommit = getCommit(repo, mb);
  if (mbCommit === null) return null;
  const mbTree = flattenTree(repo, mbCommit.tree);
  const baseTree = flattenTree(repo, baseCommit.tree);
  const headTree = flattenTree(repo, headCommit.tree);
  for (const path of new Set([...baseTree.keys(), ...headTree.keys(), ...mbTree.keys()])) {
    const mbSha = mbTree.get(path) ?? null;
    const baseSha2 = baseTree.get(path) ?? null;
    const headSha2 = headTree.get(path) ?? null;
    const baseChanged = baseSha2 !== mbSha;
    const headChanged = headSha2 !== mbSha;
    if (baseChanged && headChanged && baseSha2 !== headSha2) return false;
  }
  return true;
}

function pullFiles(repo: Repo, pull: Pull): FileDiff[] {
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headCommit = getCommit(repo, headSha);
  const baseCommit = getCommit(repo, baseSha);
  if (headCommit === null || baseCommit === null) return [];
  const mb = mergeBase(repo, headSha, baseSha);
  const mbTree =
    mb === null ? new Map<string, string>() : flattenTree(repo, (getCommit(repo, mb) ?? { tree: '' }).tree);
  const headTree = flattenTree(repo, headCommit.tree);
  void baseCommit;
  return diffFileMaps(repo, mbTree, headTree);
}

/** The squash tree: base tree overlaid with the head's changes since the merge-base. */
function squashTree(repo: Repo, pull: Pull): Map<string, string> {
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headCommit = getCommit(repo, headSha);
  const baseCommit = getCommit(repo, baseSha);
  if (headCommit === null || baseCommit === null) return new Map();
  const baseTree = flattenTree(repo, baseCommit.tree);
  const headTree = flattenTree(repo, headCommit.tree);
  const mb = mergeBase(repo, headSha, baseSha);
  if (mb === null) return new Map(headTree);
  const mbTree = flattenTree(repo, (getCommit(repo, mb) ?? { tree: '' }).tree);
  const out = new Map(baseTree);
  for (const path of new Set([...mbTree.keys(), ...headTree.keys()])) {
    const mbSha = mbTree.get(path) ?? null;
    const headSha2 = headTree.get(path) ?? null;
    if (headSha2 !== mbSha) {
      if (headSha2 === null) out.delete(path);
      else out.set(path, headSha2);
    }
  }
  return out;
}

function handlePulls(r: RepoReq): boolean {
  const repo = r.repo;
  const store = r.ctx.store;
  const tail = r.tail;
  if (tail.length === 1) {
    if (r.method === 'GET') {
      let list = [...repo.pulls.values()];
      const state = r.q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      sendPage(r.req, r.res, r.ctx, list, (p) => pullJson(repo, p, pullMergeable(repo, p)));
      return true;
    }
    if (r.method === 'POST') {
      const b = bodyObject(r.body);
      const title = b === null ? null : str(b.title);
      if (title === null || title === '') {
        fail(r.res, r.ctx, 422, 'Validation Failed: title is required');
        return true;
      }
      const headRaw = b === null ? null : str(b.head);
      const baseRaw = b === null ? null : str(b.base);
      if (headRaw === null) {
        fail(r.res, r.ctx, 422, 'Validation Failed: head is required');
        return true;
      }
      const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const baseRef =
        baseRaw === null || baseRaw === ''
          ? repo.default_branch
          : baseRaw.includes(':')
            ? (baseRaw.split(':').pop() as string)
            : baseRaw;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) {
        fail(r.res, r.ctx, 422, 'Validation Failed: head branch does not exist');
        return true;
      }
      if (baseSha === undefined) {
        fail(r.res, r.ctx, 422, 'Validation Failed: base branch does not exist');
        return true;
      }
      const now = store.clock.tickIso();
      const number = repo.nextPullNumber++;
      const pull: Pull = {
        id: store.nextGlobalId(),
        number,
        title,
        body: b !== null && typeof b.body === 'string' ? b.body : '',
        state: 'open',
        head: {
          label: `${VIEWER.login}:${headRef}`,
          ref: headRef,
          sha: headSha,
          repo: { id: repo.id, full_name: repo.full_name },
        },
        base: {
          label: `${VIEWER.login}:${baseRef}`,
          ref: baseRef,
          sha: baseSha,
          repo: { id: repo.id, full_name: repo.full_name },
        },
        merged: false,
        mergeable: null,
        merge_commit_sha: null,
        user: VIEWER,
        created_at: now,
        updated_at: now,
        closed_at: null,
        merged_at: null,
        html_url: `https://github.com/${r.owner}/${r.repoName}/pull/${number}`,
        url: `/api/v3/repos/${r.owner}/${r.repoName}/pulls/${number}`,
      };
      pull.mergeable = pullMergeable(repo, pull);
      repo.pulls.set(number, pull);
      send(r.res, r.ctx, 201, pullJson(repo, pull, pull.mergeable));
      return true;
    }
    notFound(r);
    return true;
  }
  const num = parseInt(tail[1] as string, 10);
  if (!Number.isInteger(num)) {
    notFound(r);
    return true;
  }
  const pull = repo.pulls.get(num);
  if (tail.length === 2) {
    if (r.method === 'GET') {
      if (pull === undefined) {
        notFound(r);
        return true;
      }
      send(r.res, r.ctx, 200, pullJson(repo, pull, pullMergeable(repo, pull)));
      return true;
    }
    if (r.method === 'PATCH') {
      if (pull === undefined) {
        notFound(r);
        return true;
      }
      const b = bodyObject(r.body);
      if (b === null) {
        fail(r.res, r.ctx, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof b.title === 'string') pull.title = b.title;
      if (typeof b.body === 'string') pull.body = b.body;
      if (b.state === 'open' || b.state === 'closed') {
        pull.state = b.state;
        pull.closed_at = b.state === 'closed' ? store.clock.nowIso() : null;
      }
      pull.updated_at = store.clock.tickIso();
      send(r.res, r.ctx, 200, pullJson(repo, pull, pullMergeable(repo, pull)));
      return true;
    }
    notFound(r);
    return true;
  }
  if (tail.length === 3 && tail[2] === 'files') {
    if (r.method !== 'GET') {
      notFound(r);
      return true;
    }
    if (pull === undefined) {
      notFound(r);
      return true;
    }
    const files = pullFiles(repo, pull);
    send(
      r.res,
      r.ctx,
      200,
      files.map((f) => ({
        sha: '',
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: `https://github.com/${r.owner}/${r.repoName}/blob/${pull.head.sha}/${f.filename}`,
        raw_url: `https://github.com/${r.owner}/${r.repoName}/raw/${pull.head.sha}/${f.filename}`,
        contents_url: `/api/v3/repos/${r.owner}/${r.repoName}/contents/${f.filename}?ref=${pull.head.sha}`,
        patch: '',
      })),
    );
    return true;
  }
  if (tail.length === 3 && tail[2] === 'merge') {
    if (r.method !== 'PUT') {
      notFound(r);
      return true;
    }
    if (pull === undefined) {
      notFound(r);
      return true;
    }
    if (pull.state === 'closed') {
      fail(r.res, r.ctx, 405, 'Pull request is already closed');
      return true;
    }
    if (pullMergeable(repo, pull) === false) {
      fail(r.res, r.ctx, 405, 'Merge conflict: the pull request cannot be merged');
      return true;
    }
    const mergedTree = squashTree(repo, pull);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (baseTip === undefined) {
      notFound(r);
      return true;
    }
    const treeSha = buildTree(repo, mergedTree);
    const { sha: mergeSha } = createCommitObject(repo, r.ctx, treeSha, [baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
    const now = store.clock.nowIso();
    repo.pushed_at = now;
    repo.updated_at = now;
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = now;
    pull.closed_at = now;
    pull.updated_at = now;
    send(r.res, r.ctx, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }
  notFound(r);
  return true;
}

/** Immediate children of a directory (path '' = root) in a tree, as contents entries. */
function dirListing(repo: Repo, treeSha: string, dirPath: string, owner: string, repoName: string): Json[] {
  const out: Json[] = [];
  // Walk to the subtree for dirPath.
  let curSha = treeSha;
  if (dirPath !== '') {
    for (const part of dirPath.split('/')) {
      const obj = repo.objects.get(curSha);
      if (obj === undefined || obj.type !== 'tree') return out;
      const found = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (found === undefined) return out;
      curSha = found.sha;
    }
  }
  const obj = repo.objects.get(curSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const p = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
    const isDir = e.mode === '40000';
    const size = isDir ? 0 : (repo.objects.get(e.sha)?.data.length ?? 0);
    out.push({
      type: isDir ? 'dir' : 'file',
      size,
      name: e.name,
      path: p,
      sha: e.sha,
      url: `/api/v3/repos/${owner}/${repoName}/contents/${p}`,
      git_url: `/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${e.sha}`,
      html_url: `https://github.com/${owner}/${repoName}/${isDir ? 'tree' : 'blob'}/main/${p}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${repoName}/main/${p}`,
      _links: {
        git: `/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${e.sha}`,
        self: `/api/v3/repos/${owner}/${repoName}/contents/${p}`,
        html: `https://github.com/${owner}/${repoName}/${isDir ? 'tree' : 'blob'}/main/${p}`,
      },
    });
  }
  out.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();

  // Auth: every /api/v3 call requires the bearer token.
  if (!isAuthorized(req)) {
    fail(res, ctx, 401, 'Bad credentials');
    return true;
  }

  // Read + parse a JSON body for methods that carry one.
  let body: unknown = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    try {
      const buf = await readBody(req);
      body = parseJsonBody(buf);
    } catch {
      fail(res, ctx, 400, 'Problems parsing JSON');
      return true;
    }
  }

  const rest = path.slice('/api/v3'.length);
  const rawSegs = rest.split('/').filter((s) => s.length > 0);
  const segs: string[] = [];
  for (const s of rawSegs) {
    const d = decodeSegment(s);
    if (d === null) {
      fail(res, ctx, 404, 'Not Found');
      return true;
    }
    segs.push(d);
  }
  const q = queryOf(req);
  const r: Req = { req, res, ctx, method, segs, q, body };

  if (segs.length === 0) return handleRoot(r);
  if (segs.length === 1 && segs[0] === 'meta') return handleMeta(r);
  if (segs[0] === 'user') return handleUser(r);

  if (segs[0] === 'repos') {
    if (segs.length < 3) {
      notFound(r);
      return true;
    }
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    const repo = lookupRepo(ctx, owner, repoName);
    if (repo === null) {
      notFound(r);
      return true;
    }
    const tail = segs.slice(3);
    const rr: RepoReq = { ...r, repo, owner, repoName, tail };
    if (tail.length === 0) return handleRepoRoot(rr);
    const section = tail[0] as string;
    if (section === 'branches') return handleBranches(rr);
    if (section === 'commits') return handleCommits(rr);
    if (section === 'git' && tail[1] === 'refs') return handleGitRefs(rr);
    if (section === 'git' && tail[1] === 'commits' && tail.length === 3) return handleGitCommit(rr);
    if (section === 'contents') return handleContents(rr);
    if (section === 'labels') return handleLabels(rr);
    if (section === 'issues') return handleIssues(rr);
    if (section === 'pulls') return handlePulls(rr);
    notFound(r);
    return true;
  }

  notFound(r);
  return true;
}
