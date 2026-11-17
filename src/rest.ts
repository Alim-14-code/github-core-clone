// REST v3 surface for the git forge (GitHub-compatible, /api/v3).
// Deterministic: all timestamps come from ctx.store.clock, all ids from store
// counters, git object ids are content hashes. No wall clock, no randomness.

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

function rid(ctx: Ctx): string {
  return nextRequestId(ctx.requestSeq);
}

function send(res: ServerResponse, ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': rid(ctx), ...extra });
}

function fail(res: ServerResponse, ctx: Ctx, status: number, message: string, extra: Record<string, string> = {}): void {
  send(res, ctx, status, { message }, extra);
}

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

function userJson(login: string, id: number): Json {
  return {
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
}

// ---------------------------------------------------------------------------------------------
// Serializers

function repoJson(r: Repo): Json {
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
    open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
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
  return { id: l.id, node_id: Buffer.from(`07:Label${l.id}`).toString('base64'), url: l.url, name: l.name, color: l.color, default: false, description: l.description };
}

function issueJson(r: Repo, i: Issue): Json {
  return {
    id: i.id,
    node_id: Buffer.from(`01:Issue${i.id}`).toString('base64'),
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

function commentJson(r: Repo, issue: Issue, c: { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string; html_url: string; url: string }): Json {
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

function pullJson(r: Repo, p: Pull, mergeable: boolean | null): Json {
  const headRepo = p.head.repo === null ? null : { id: p.head.repo.id, node_id: Buffer.from(`010:Repository${p.head.repo.id}`).toString('base64'), name: r.name, full_name: p.head.repo.full_name, private: r.private, owner: userJson(r.owner, VIEWER.id) };
  const baseRepo = p.base.repo === null ? null : { id: p.base.repo.id, node_id: Buffer.from(`010:Repository${p.base.repo.id}`).toString('base64'), name: r.name, full_name: p.base.repo.full_name, private: r.private, owner: userJson(r.owner, VIEWER.id) };
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
    head: { label: p.head.label, ref: p.head.ref, sha: p.head.sha, user: userJson(r.owner, VIEWER.id), repo: headRepo },
    base: { label: p.base.label, ref: p.base.ref, sha: p.base.sha, user: userJson(r.owner, VIEWER.id), repo: baseRepo },
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

// ---------------------------------------------------------------------------------------------
// Pagination

function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const rawPer = parseInt(q.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(rawPer) && rawPer > 0 ? rawPer : 30));
  return { page, perPage };
}

function paginate<T>(req: IncomingMessage, q: URLSearchParams, items: readonly T[]): { items: T[]; link: string | null } {
  const { page, perPage } = pageParams(q);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  let link: string | null = null;
  if (page < totalPages) {
    const host = req.headers.host ?? 'localhost';
    const base = `http://${host}${pathOf(req)}`;
    const mk = (p: number): string => {
      const params = new URLSearchParams(q);
      params.set('page', String(p));
      params.set('per_page', String(perPage));
      return `${base}?${params.toString()}`;
    };
    link = `<${mk(page + 1)}>; rel="next", <${mk(totalPages)}>; rel="last"`;
  }
  return { items: pageItems, link };
}

function sendPage<T>(req: IncomingMessage, res: ServerResponse, ctx: Ctx, items: readonly T[], toJson: (item: T) => unknown): void {
  const q = queryOf(req);
  const { items: pageItems, link } = paginate(req, q, items);
  const extra: Record<string, string> = {};
  if (link !== null) extra.link = link;
  send(res, ctx, 200, pageItems.map(toJson), extra);
}

// ---------------------------------------------------------------------------------------------
// Git object helpers (all inside rest.ts; repo.objects is the loose store)

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
  const out: ParsedCommit = { tree: '', parents: [], authorName: '', authorEmail: '', authorTs: 0, committerName: '', committerEmail: '', committerTs: 0, message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const isAuthor = line.startsWith('author ');
      const rest = line.slice(isAuthor ? 7 : 10);
      const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(rest);
      if (m !== null) {
        const name = m[1] ?? '';
        const email = m[2] ?? '';
        const ts = parseInt(m[3] ?? '0', 10) || 0;
        if (isAuthor) { out.authorName = name; out.authorEmail = email; out.authorTs = ts; }
        else { out.committerName = name; out.committerEmail = email; out.committerTs = ts; }
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
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}

/** Flatten a tree (by sha) to path -> blob sha. */
function flattenTree(repo: Repo, treeSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Array<{ sha: string; prefix: string }> = [{ sha: treeSha, prefix: '' }];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    const obj = repo.objects.get(cur.sha);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const e of parseTree(obj.data)) {
      const p = cur.prefix === '' ? e.name : `${cur.prefix}/${e.name}`;
      if (e.mode === '40000') stack.push({ sha: e.sha, prefix: p });
      else out.set(p, e.sha);
    }
  }
  return out;
}

/** Build nested trees from a path -> blob sha map; stores trees; returns root tree sha. */
function buildTree(repo: Repo, files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const dirs = new Map<string, null>();
    const entries: TreeEntry[] = [];
    for (const [path, sha] of files) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: '100644', name: rest, sha });
      else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) { dirs.set(dir, null); entries.push({ mode: '40000', name: dir, sha: '' }); }
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const parts: Buffer[] = [];
    for (const e of entries) {
      const sha = e.mode === '40000' ? build(prefix === '' ? `${e.name}/` : `${prefix}${e.name}/`) : e.sha;
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(sha, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(parts));
  };
  return build('');
}

function createCommitObject(repo: Repo, ctx: Ctx, treeSha: string, parents: string[], message: string): { sha: string; ts: number } {
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
    const obj = repo.objects.get(refish.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return refish.toLowerCase();
    if (obj !== undefined && obj.type === 'tag') return refish.toLowerCase();
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
  for (const sha of ancestors(repo, a)) if (bAnc.has(sha)) return sha;
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

function countLineDiff(repo: Repo, oldSha: string | null, newSha: string | null): { additions: number; deletions: number } {
  const oldLines = blobLines(repo, oldSha);
  const newLines = blobLines(repo, newSha);
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const left = oldCount.get(l) ?? 0;
    if (left > 0) oldCount.set(l, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
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

function commitJson(repo: Repo, sha: string, c: ParsedCommit): Json {
  const author = { name: c.authorName, email: c.authorEmail, date: isoOfUnix(c.authorTs) };
  const committer = { name: c.committerName, email: c.committerEmail, date: isoOfUnix(c.committerTs) };
  return {
    sha,
    node_id: Buffer.from(`04:Commit${sha}`).toString('base64'),
    commit: {
      author,
      committer,
      message: c.message,
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

// ---------------------------------------------------------------------------------------------
// Repo lookup (owner must be the viewer; any other owner is 404, never 403)

function lookupRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function bodyObject(body: unknown): Json | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------------------------

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
    if (d === null) { fail(res, ctx, 404, 'Not Found'); return true; }
    segs.push(d);
  }
  const q = queryOf(req);
  const store = ctx.store;

  // GET /api/v3/
  if (segs.length === 0) {
    if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
    send(res, ctx, 200, {
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
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
    send(res, ctx, 200, { verifiable_password_authentication: true, ssh_key_fingerprints: {}, ssh_keys: [], hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [], installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user  (+ /user/repos)
  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
      send(res, ctx, 200, {
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
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') {
        sendPage(req, res, ctx, store.viewerRepos(), (r) => repoJson(r));
        return true;
      }
      if (method === 'POST') {
        const b = bodyObject(body);
        const name = b === null ? null : str(b.name);
        if (name === null || name === '') { fail(res, ctx, 422, 'Validation Failed: name is required'); return true; }
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          fail(res, ctx, 422, 'Validation Failed: name already exists on this account');
          return true;
        }
        const isPrivate = b !== null && b.private === true;
        const description = b !== null && typeof b.description === 'string' ? b.description : '';
        const defaultBranch = b !== null && typeof b.default_branch === 'string' && b.default_branch !== '' ? b.default_branch : 'main';
        const repo = store.createRepo(name, description, isPrivate, defaultBranch);
        store.defaultLabels(repo);
        send(res, ctx, 201, repoJson(repo));
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }
    fail(res, ctx, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs[0] === 'repos') {
    if (segs.length < 3) { fail(res, ctx, 404, 'Not Found'); return true; }
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    const repo = lookupRepo(ctx, owner, repoName);
    if (repo === null) { fail(res, ctx, 404, 'Not Found'); return true; }
    const tail = segs.slice(3);

    // /repos/{o}/{r} itself
    if (tail.length === 0) {
      if (method === 'GET') { send(res, ctx, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const b = bodyObject(body);
        if (b === null) { fail(res, ctx, 400, 'Problems parsing JSON'); return true; }
        if (typeof b.description === 'string') repo.description = b.description;
        if (b.private === true || b.private === false) repo.private = b.private;
        if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.default_branch = b.default_branch;
        if (typeof b.name === 'string' && b.name !== '' && b.name !== repo.name) {
          if (store.getRepo(owner, b.name) !== undefined) { fail(res, ctx, 422, 'Validation Failed: name already exists on this account'); return true; }
          store.repos.delete(store.repoKey(owner, repo.name));
          repo.name = b.name;
          repo.full_name = `${owner}/${b.name}`;
          repo.html_url = `https://github.com/${owner}/${b.name}`;
          repo.url = `/api/v3/repos/${owner}/${b.name}`;
          store.repos.set(store.repoKey(owner, repo.name), repo);
        }
        repo.updated_at = store.clock.tickIso();
        send(res, ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        noContent(res, ctx);
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    const section = tail[0] as string;

    // ---- branches ----
    if (section === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
        const list: Json[] = [];
        for (const [ref, sha] of repo.refs) {
          if (!ref.startsWith('refs/heads/')) continue;
          const name = ref.slice('refs/heads/'.length);
          list.push({ name, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false });
        }
        sendPage(req, res, ctx, list, (x) => x);
        return true;
      }
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (method === 'GET') {
        if (sha === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        send(res, ctx, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false });
        return true;
      }
      if (method === 'DELETE') {
        if (sha === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        repo.refs.delete(`refs/heads/${branch}`);
        noContent(res, ctx);
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    // ---- commits ----
    if (section === 'commits') {
      if (tail.length === 1) {
        if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
        const refish = q.get('sha') ?? repo.default_branch;
        const tip = resolveRef(repo, refish);
        if (tip === null) { fail(res, ctx, 404, 'Not Found'); return true; }
        const pathFilter = q.get('path');
        const items: Json[] = [];
        for (const sha of ancestors(repo, tip)) {
          const c = getCommit(repo, sha);
          if (c === null) continue;
          if (pathFilter !== null) {
            const tree = flattenTree(repo, c.tree);
            const parentTree = c.parents.length > 0 ? flattenTree(repo, (getCommit(repo, c.parents[0] as string) ?? { tree: '' }).tree) : new Map<string, string>();
            if (tree.get(pathFilter) === parentTree.get(pathFilter)) continue;
          }
          items.push(commitJson(repo, sha, c));
        }
        sendPage(req, res, ctx, items, (x) => x);
        return true;
      }
      const sha = tail.slice(1).join('/');
      if (method === 'GET') {
        const c = getCommit(repo, sha);
        if (c === null) { fail(res, ctx, 404, 'Not Found'); return true; }
        send(res, ctx, 200, commitJson(repo, sha.toLowerCase(), c));
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    // ---- git/refs ----
    if (section === 'git' && tail[1] === 'refs') {
      if (tail.length === 2) {
        if (method === 'POST') {
          const b = bodyObject(body);
          const ref = b === null ? null : str(b.ref);
          const sha = b === null ? null : str(b.sha);
          if (ref === null || sha === null || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))) {
            fail(res, ctx, 422, 'Validation Failed: ref and sha are required');
            return true;
          }
          if (repo.refs.has(ref)) { fail(res, ctx, 422, 'Validation Failed: ref already exists'); return true; }
          if (repo.objects.get(sha) === undefined) { fail(res, ctx, 422, 'Validation Failed: sha does not exist'); return true; }
          repo.refs.set(ref, sha);
          send(res, ctx, 201, { ref, node_id: Buffer.from(`04:Ref${ref}`).toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
          return true;
        }
        if (method === 'GET') {
          const list: Json[] = [];
          for (const [ref, sha] of repo.refs) {
            list.push({ ref, node_id: Buffer.from(`04:Ref${ref}`).toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
          }
          sendPage(req, res, ctx, list, (x) => x);
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      const refName = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(refName);
      if (method === 'GET') {
        if (sha === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        send(res, ctx, 200, { ref: refName, node_id: Buffer.from(`04:Ref${refName}`).toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refName.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
        return true;
      }
      if (method === 'PATCH') {
        if (sha === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        const b = bodyObject(body);
        const newSha = b === null ? null : str(b.sha);
        if (newSha === null || repo.objects.get(newSha) === undefined) { fail(res, ctx, 422, 'Validation Failed: sha does not exist'); return true; }
        repo.refs.set(refName, newSha);
        send(res, ctx, 200, { ref: refName, node_id: Buffer.from(`04:Ref${refName}`).toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refName.replace(/^refs\//, '')}`, object: { sha: newSha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${newSha}` } });
        return true;
      }
      if (method === 'DELETE') {
        if (sha === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        repo.refs.delete(refName);
        noContent(res, ctx);
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    // ---- git/commits (read) ----
    if (section === 'git' && tail[1] === 'commits' && tail.length === 3) {
      if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
      const sha = tail[2] as string;
      const c = getCommit(repo, sha);
      if (c === null) { fail(res, ctx, 404, 'Not Found'); return true; }
      send(res, ctx, 200, {
        sha: sha.toLowerCase(),
        node_id: Buffer.from(`04:Commit${sha}`).toString('base64'),
        url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}`,
        html_url: `https://github.com/${owner}/${repoName}/commit/${sha}`,
        author: { name: c.authorName, email: c.authorEmail, date: isoOfUnix(c.authorTs) },
        committer: { name: c.committerName, email: c.committerEmail, date: isoOfUnix(c.committerTs) },
        tree: { sha: c.tree, url: `/api/v3/repos/${owner}/${repoName}/git/trees/${c.tree}` },
        message: c.message,
        parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${owner}/${repoName}/git/commits/${p}`, html_url: `https://github.com/${owner}/${repoName}/commit/${p}` })),
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
      });
      return true;
    }

    // ---- contents ----
    if (section === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') {
        const refish = q.get('ref') ?? repo.default_branch;
        const tip = resolveRef(repo, refish);
        if (tip === null) { fail(res, ctx, 404, 'Not Found'); return true; }
        const commit = getCommit(repo, tip);
        if (commit === null) { fail(res, ctx, 404, 'Not Found'); return true; }
        const treeMap = flattenTree(repo, commit.tree);
        if (filePath === '') {
          // Root directory listing.
          const entries = dirListing(repo, commit.tree, '', owner, repoName);
          send(res, ctx, 200, entries);
          return true;
        }
        const blobSha = treeMap.get(filePath);
        if (blobSha !== undefined) {
          const obj = repo.objects.get(blobSha);
          const size = obj === undefined ? 0 : obj.data.length;
          const name = filePath.slice(filePath.lastIndexOf('/') + 1);
          send(res, ctx, 200, {
            type: 'file', encoding: 'base64', size, name, path: filePath, content: obj === undefined ? '' : b64encode(obj.data),
            sha: blobSha, url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${refish}/${filePath}`, download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${refish}/${filePath}`,
            _links: { git: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`, self: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, html: `https://github.com/${owner}/${repoName}/blob/${refish}/${filePath}` },
          });
          return true;
        }
        // Directory?
        const prefix = `${filePath}/`;
        let isDir = false;
        for (const p of treeMap.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
        if (isDir) {
          send(res, ctx, 200, dirListing(repo, commit.tree, filePath, owner, repoName));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const b = bodyObject(body);
        if (b === null) { fail(res, ctx, 400, 'Problems parsing JSON'); return true; }
        const contentB64 = str(b.content);
        if (contentB64 === null) { fail(res, ctx, 422, 'Validation Failed: content is required'); return true; }
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.default_branch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined && repo.refs.size > 0) { fail(res, ctx, 404, 'Not Found'); return true; }
        const baseCommit = tip === undefined ? null : getCommit(repo, tip);
        const treeMap = baseCommit === null ? new Map<string, string>() : flattenTree(repo, baseCommit.tree);
        const existingSha = treeMap.get(filePath);
        const givenSha = str(b.sha);
        if (givenSha !== null && existingSha !== undefined && givenSha.toLowerCase() !== existingSha.toLowerCase()) {
          fail(res, ctx, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        if (givenSha !== null && existingSha === undefined) {
          fail(res, ctx, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        const isCreate = existingSha === undefined;
        const contentBuf = b64decode(contentB64);
        const blobSha = storeObject(repo, 'blob', contentBuf);
        treeMap.set(filePath, blobSha);
        const treeSha = buildTree(repo, treeMap);
        const message = typeof b.message === 'string' && b.message !== '' ? b.message : isCreate ? `Create ${filePath}` : `Update ${filePath}`;
        const parents = tip === undefined ? [] : [tip];
        const { sha: commitSha } = createCommitObject(repo, ctx, treeSha, parents, message);
        repo.refs.set(refName, commitSha);
        const now = store.clock.nowIso();
        repo.pushed_at = now;
        repo.updated_at = now;
        const name = filePath.slice(filePath.lastIndexOf('/') + 1);
        send(res, ctx, isCreate ? 201 : 200, {
          content: {
            type: 'file', encoding: 'base64', size: contentBuf.length, name, path: filePath, content: b64encode(contentBuf),
            sha: blobSha, url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}`, download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${filePath}`,
            _links: { git: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`, self: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, html: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}` },
          },
          commit: { sha: commitSha, node_id: Buffer.from(`04:Commit${commitSha}`).toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/commits/${commitSha}`, html_url: `https://github.com/${owner}/${repoName}/commit/${commitSha}`, author: { name: VIEWER.name, email: VIEWER.email, date: now }, committer: { name: VIEWER.name, email: VIEWER.email, date: now }, message, tree: { sha: treeSha, url: `/api/v3/repos/${owner}/${repoName}/git/trees/${treeSha}` }, parents: parents.map((p) => ({ sha: p, url: `/api/v3/repos/${owner}/${repoName}/commits/${p}`, html_url: `https://github.com/${owner}/${repoName}/commit/${p}` })) },
        });
        return true;
      }
      if (method === 'DELETE') {
        const b = bodyObject(body);
        const branch = b !== null && typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.default_branch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        const baseCommit = getCommit(repo, tip);
        if (baseCommit === null) { fail(res, ctx, 404, 'Not Found'); return true; }
        const treeMap = flattenTree(repo, baseCommit.tree);
        const existingSha = treeMap.get(filePath);
        if (existingSha === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        const givenSha = b === null ? null : str(b.sha);
        if (givenSha !== null && givenSha.toLowerCase() !== existingSha.toLowerCase()) {
          fail(res, ctx, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        treeMap.delete(filePath);
        const treeSha = buildTree(repo, treeMap);
        const message = b !== null && typeof b.message === 'string' && b.message !== '' ? b.message : `Delete ${filePath}`;
        const { sha: commitSha } = createCommitObject(repo, ctx, treeSha, [tip], message);
        repo.refs.set(refName, commitSha);
        const now = store.clock.nowIso();
        repo.pushed_at = now;
        repo.updated_at = now;
        send(res, ctx, 200, {
          content: null,
          commit: { sha: commitSha, node_id: Buffer.from(`04:Commit${commitSha}`).toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/commits/${commitSha}`, html_url: `https://github.com/${owner}/${repoName}/commit/${commitSha}`, author: { name: VIEWER.name, email: VIEWER.email, date: now }, committer: { name: VIEWER.name, email: VIEWER.email, date: now }, message, tree: { sha: treeSha, url: `/api/v3/repos/${owner}/${repoName}/git/trees/${treeSha}` }, parents: [{ sha: tip, url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}`, html_url: `https://github.com/${owner}/${repoName}/commit/${tip}` }] },
        });
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    // ---- labels ----
    if (section === 'labels') {
      if (tail.length === 1) {
        if (method === 'GET') {
          sendPage(req, res, ctx, [...repo.labels.values()], (l) => labelJson(l));
          return true;
        }
        if (method === 'POST') {
          const b = bodyObject(body);
          const name = b === null ? null : str(b.name);
          if (name === null || name === '') { fail(res, ctx, 422, 'Validation Failed: name is required'); return true; }
          const existing = repo.labels.get(name);
          if (existing !== undefined) { send(res, ctx, 201, labelJson(existing)); return true; }
          const color = b !== null && typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
          const description = b !== null && typeof b.description === 'string' ? b.description : '';
          const label: Label = { id: repo.nextLabelId++, name, color, description, url: `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}` };
          repo.labels.set(name, label);
          send(res, ctx, 201, labelJson(label));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      const labelName = tail.slice(1).join('/');
      const label = repo.labels.get(labelName);
      if (method === 'GET') {
        if (label === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        send(res, ctx, 200, labelJson(label));
        return true;
      }
      if (method === 'PATCH') {
        if (label === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        const b = bodyObject(body);
        if (b !== null) {
          if (typeof b.color === 'string') label.color = b.color.replace(/^#/, '');
          if (typeof b.description === 'string') label.description = b.description;
          if (typeof b.new_name === 'string' && b.new_name !== '' && b.new_name !== label.name) {
            repo.labels.delete(label.name);
            label.name = b.new_name;
            label.url = `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(label.name)}`;
            repo.labels.set(label.name, label);
          }
        }
        send(res, ctx, 200, labelJson(label));
        return true;
      }
      if (method === 'DELETE') {
        if (label === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        repo.labels.delete(labelName);
        noContent(res, ctx);
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    // ---- issues ----
    if (section === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues.values()];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          const dir = direction === 'asc' ? 1 : -1;
          list.sort((a, b) => {
            let cmp = 0;
            if (sort === 'updated') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
            else if (sort === 'comments') cmp = a.comments.length - b.comments.length;
            else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
            if (cmp === 0) cmp = a.number - b.number;
            return cmp * dir;
          });
          // Default GitHub order for issues list is created desc; the sort above already
          // applies direction. For sort=created + direction=desc this is newest first.
          sendPage(req, res, ctx, list, (i) => issueJson(repo, i));
          return true;
        }
        if (method === 'POST') {
          const b = bodyObject(body);
          const title = b === null ? null : str(b.title);
          if (title === null || title === '') { fail(res, ctx, 422, 'Validation Failed: title is required'); return true; }
          const labels = resolveIssueLabels(repo, b);
          if (labels === null) { fail(res, ctx, 422, `Validation Failed: label does not exist`); return true; }
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
            html_url: `https://github.com/${owner}/${repoName}/issues/${number}`,
            url: `/api/v3/repos/${owner}/${repoName}/issues/${number}`,
            comments_url: `/api/v3/repos/${owner}/${repoName}/issues/${number}/comments`,
          };
          repo.issues.set(number, issue);
          send(res, ctx, 201, issueJson(repo, issue));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      const num = parseInt(tail[1] as string, 10);
      if (!Number.isInteger(num)) { fail(res, ctx, 404, 'Not Found'); return true; }
      const issue = repo.issues.get(num);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (issue === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
          send(res, ctx, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (issue === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
          const b = bodyObject(body);
          if (b === null) { fail(res, ctx, 400, 'Problems parsing JSON'); return true; }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') {
            issue.state = b.state;
            issue.closed_at = b.state === 'closed' ? store.clock.nowIso() : null;
          }
          if (b.labels !== undefined) {
            const labels = resolveIssueLabels(repo, b);
            if (labels === null) { fail(res, ctx, 422, 'Validation Failed: label does not exist'); return true; }
            issue.labels = labels;
          }
          issue.updated_at = store.clock.tickIso();
          if (issue.state === 'closed' && issue.closed_at === null) issue.closed_at = issue.updated_at;
          send(res, ctx, 200, issueJson(repo, issue));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      // /issues/{n}/comments  or  /issues/{n}/labels
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        if (method === 'GET') {
          sendPage(req, res, ctx, issue.comments, (c) => commentJson(repo, issue, c));
          return true;
        }
        if (method === 'POST') {
          const b = bodyObject(body);
          const cbody = b === null ? null : str(b.body);
          if (cbody === null) { fail(res, ctx, 422, 'Validation Failed: body is required'); return true; }
          const now = store.clock.tickIso();
          const id = repo.nextCommentId++;
          const comment = {
            id,
            body: cbody,
            user: VIEWER,
            created_at: now,
            updated_at: now,
            html_url: `https://github.com/${owner}/${repoName}/issues/${num}#issuecomment-${id}`,
            url: `/api/v3/repos/${owner}/${repoName}/issues/comments/${id}`,
          };
          issue.comments.push(comment);
          issue.updated_at = store.clock.nowIso();
          send(res, ctx, 201, commentJson(repo, issue, comment));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'labels') {
        if (issue === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        if (method === 'GET') { send(res, ctx, 200, issue.labels.map(labelJson)); return true; }
        if (method === 'POST') {
          const b = bodyObject(body);
          const labels = resolveIssueLabels(repo, b);
          if (labels === null) { fail(res, ctx, 422, 'Validation Failed: label does not exist'); return true; }
          for (const l of labels) if (!issue.labels.some((x) => x.name === l.name)) issue.labels.push(l);
          issue.updated_at = store.clock.tickIso();
          send(res, ctx, 200, issue.labels.map(labelJson));
          return true;
        }
        if (method === 'DELETE') {
          issue.labels = [];
          issue.updated_at = store.clock.tickIso();
          send(res, ctx, 200, []);
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    // ---- pulls ----
    if (section === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls.values()];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          sendPage(req, res, ctx, list, (p) => pullJson(repo, p, pullMergeable(repo, p)));
          return true;
        }
        if (method === 'POST') {
          const b = bodyObject(body);
          const title = b === null ? null : str(b.title);
          if (title === null || title === '') { fail(res, ctx, 422, 'Validation Failed: title is required'); return true; }
          const headRaw = b === null ? null : str(b.head);
          const baseRaw = b === null ? null : str(b.base);
          if (headRaw === null) { fail(res, ctx, 422, 'Validation Failed: head is required'); return true; }
          const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
          const baseRef = baseRaw === null || baseRaw === '' ? repo.default_branch : baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined) { fail(res, ctx, 422, 'Validation Failed: head branch does not exist'); return true; }
          if (baseSha === undefined) { fail(res, ctx, 422, 'Validation Failed: base branch does not exist'); return true; }
          const now = store.clock.tickIso();
          const number = repo.nextPullNumber++;
          const pull: Pull = {
            id: store.nextGlobalId(),
            number,
            title,
            body: b !== null && typeof b.body === 'string' ? b.body : '',
            state: 'open',
            head: { label: `${VIEWER.login}:${headRef}`, ref: headRef, sha: headSha, repo: { id: repo.id, full_name: repo.full_name } },
            base: { label: `${VIEWER.login}:${baseRef}`, ref: baseRef, sha: baseSha, repo: { id: repo.id, full_name: repo.full_name } },
            merged: false,
            mergeable: null,
            merge_commit_sha: null,
            user: VIEWER,
            created_at: now,
            updated_at: now,
            closed_at: null,
            merged_at: null,
            html_url: `https://github.com/${owner}/${repoName}/pull/${number}`,
            url: `/api/v3/repos/${owner}/${repoName}/pulls/${number}`,
          };
          pull.mergeable = pullMergeable(repo, pull);
          repo.pulls.set(number, pull);
          send(res, ctx, 201, pullJson(repo, pull, pull.mergeable));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      const num = parseInt(tail[1] as string, 10);
      if (!Number.isInteger(num)) { fail(res, ctx, 404, 'Not Found'); return true; }
      const pull = repo.pulls.get(num);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (pull === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
          send(res, ctx, 200, pullJson(repo, pull, pullMergeable(repo, pull)));
          return true;
        }
        if (method === 'PATCH') {
          if (pull === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
          const b = bodyObject(body);
          if (b === null) { fail(res, ctx, 400, 'Problems parsing JSON'); return true; }
          if (typeof b.title === 'string') pull.title = b.title;
          if (typeof b.body === 'string') pull.body = b.body;
          if (b.state === 'open' || b.state === 'closed') {
            pull.state = b.state;
            pull.closed_at = b.state === 'closed' ? store.clock.nowIso() : null;
          }
          pull.updated_at = store.clock.tickIso();
          send(res, ctx, 200, pullJson(repo, pull, pullMergeable(repo, pull)));
          return true;
        }
        fail(res, ctx, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') { fail(res, ctx, 404, 'Not Found'); return true; }
        if (pull === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        const files = pullFiles(repo, pull);
        send(res, ctx, 200, files.map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: `https://github.com/${owner}/${repoName}/blob/${pull.head.sha}/${f.filename}`,
          raw_url: `https://github.com/${owner}/${repoName}/raw/${pull.head.sha}/${f.filename}`,
          contents_url: `/api/v3/repos/${owner}/${repoName}/contents/${f.filename}?ref=${pull.head.sha}`,
          patch: '',
        })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') { fail(res, ctx, 404, 'Not Found'); return true; }
        if (pull === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        if (pull.state === 'closed') { fail(res, ctx, 405, 'Pull request is already closed'); return true; }
        const conflicted = pullMergeable(repo, pull) === false;
        if (conflicted) { fail(res, ctx, 405, 'Merge conflict: the pull request cannot be merged'); return true; }
        const mergedTree = squashTree(repo, pull);
        const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
        if (baseTip === undefined) { fail(res, ctx, 404, 'Not Found'); return true; }
        const treeSha = buildTree(repo, mergedTree);
        const { sha: mergeSha } = createCommitObject(repo, ctx, treeSha, [baseTip], `${pull.title} (#${pull.number})`);
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
        send(res, ctx, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      fail(res, ctx, 404, 'Not Found');
      return true;
    }

    fail(res, ctx, 404, 'Not Found');
    return true;
  }

  fail(res, ctx, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Issue label resolution: body.labels may be strings or {name} objects.

function resolveIssueLabels(repo: Repo, b: Json | null): Label[] | null {
  if (b === null || b.labels === undefined) return [];
  if (!Array.isArray(b.labels)) return null;
  const out: Label[] = [];
  for (const item of b.labels) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? str((item as Json).name) : null;
    if (name === null) return null;
    const label = repo.labels.get(name) ?? [...repo.labels.values()].find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (label === undefined) return null;
    out.push(label);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pull mergeability / files, computed from the object store (no side state, so pulls
// created over git/GraphQL/MCP merge the same way).

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
  const mbTree = mb === null ? new Map<string, string>() : flattenTree(repo, (getCommit(repo, mb) ?? { tree: '' }).tree);
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
      _links: { git: `/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${e.sha}`, self: `/api/v3/repos/${owner}/${repoName}/contents/${p}`, html: `https://github.com/${owner}/${repoName}/${isDir ? 'tree' : 'blob'}/main/${p}` },
    });
  }
  out.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
  return out;
}
