// Shared in-memory store for the forge: repositories, git objects, issues, pull
// requests, labels and comments. One process, one Store, shared by the git smart
// HTTP, REST v3, GraphQL and MCP surfaces, so an object created on one surface
// reads back identically on the others.
//
// Determinism (the replay rule): nothing in here reads a wall clock or an
// unseeded random source. Every timestamp comes from the logical Clock below,
// which starts at the trial's now (MAKEFUN_TRIAL_NOW, the only now a request
// may carry) and advances one second per mutation, so two runs that make the
// same requests in the same order produce byte-identical state. Every id comes
// from a counter. Git object ids are content hashes, deterministic by nature.

/** The user the suite's bearer token names (the scenario's viewer; the seed is fixed in the kit's wire.ts). */
export const VIEWER: User = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const);

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: string;
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** Raw object content, without the git "<type> <size>\0" header. */
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  url: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  user: User;
  assignee: User | null;
  milestone: null;
  locked: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  comments_url: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { label: string; ref: string; sha: string; repo: { id: number; full_name: string } | null };
  base: { label: string; ref: string; sha: string; repo: { id: number; full_name: string } | null };
  merged: boolean;
  mergeable: boolean | null;
  merge_commit_sha: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  html_url: string;
  url: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  fork: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  url: string;
  /** sha -> object (loose store; packs are built from this on demand). */
  objects: Map<string, GitObject>;
  /** full ref name (refs/heads/main) -> commit sha. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  /** Per-repo counters keep ids deterministic in creation order. */
  nextCommentId: number;
  nextLabelId: number;
}

/** A monotonic logical clock: base time plus one second per mutation. */
export class Clock {
  private readonly baseMs: number;
  private ticks = 0;

  constructor() {
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    const parsed = raw === '' ? NaN : Date.parse(raw);
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.parse('2026-11-14T06:30:00Z');
  }

  /** Current logical time without advancing (for reads). */
  nowIso(): string {
    return new Date(this.baseMs + this.ticks * 1000).toISOString();
  }

  /** Current logical time as a git timestamp (seconds since epoch, UTC). */
  nowUnix(): number {
    return Math.floor(this.baseMs / 1000) + this.ticks;
  }

  /** Advance one second and return the new time (for mutations). */
  tickIso(): string {
    this.ticks += 1;
    return this.nowIso();
  }

  /** Advance one second and return the new unix time (for git objects). */
  tickUnix(): number {
    this.ticks += 1;
    return this.nowUnix();
  }
}

export class Store {
  readonly clock = new Clock();
  /** 'owner/name' -> Repo. Only the viewer's repos exist; any other owner is 404. */
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private nextRepoId = 1;

  /** A fresh global id (issues, pulls, comments, labels, users' objects). Deterministic. */
  nextGlobalId(): number {
    return this.nextId++;
  }

  nextRepoIdValue(): number {
    return this.nextRepoId++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** All repos owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    return out;
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    const now = this.clock.tickIso();
    const repo: Repo = {
      id: this.nextRepoIdValue(),
      owner: VIEWER.login,
      name,
      full_name: `${VIEWER.login}/${name}`,
      description,
      private: isPrivate,
      fork: false,
      default_branch: defaultBranch,
      created_at: now,
      updated_at: now,
      pushed_at: now,
      html_url: `https://github.com/${VIEWER.login}/${name}`,
      url: `/api/v3/repos/${VIEWER.login}/${name}`,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The default labels a fresh repository carries (GitHub's set). */
  defaultLabels(repo: Repo): void {
    const defs: Array<[string, string, string]> = [
      ['bug', 'd73a4a', "Something isn't working"],
      ['documentation', '0075ca', 'Improvements or additions to documentation'],
      ['duplicate', 'cfd3d7', 'This issue or pull request already exists'],
      ['enhancement', 'a2eeef', 'New feature or request'],
      ['good first issue', '7057ff', 'Good for newcomers'],
      ['help wanted', '008672', 'Extra attention is needed'],
      ['invalid', 'e4e669', 'This doesn\'t seem right'],
      ['question', 'd876e3', 'Further information is requested'],
      ['wontfix', 'ffffff', 'This will not be worked on'],
    ];
    for (const [name, color, description] of defs) {
      repo.labels.set(name, {
        id: repo.nextLabelId++,
        name,
        color,
        description,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
      });
    }
  }
}

/** The one store for the process. */
export function createStore(): Store {
  return new Store();
}

/** The request context every surface handler receives. */
export interface Ctx {
  store: Store;
  /** Monotonic request counter (deterministic X-GitHub-Request-Id values). */
  requestSeq: { value: number };
}
