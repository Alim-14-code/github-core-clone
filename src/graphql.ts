// GraphQL v4 surface for the forge: a small dependency-free executor over the
// shared store. Implements exactly the documents the conformance suite sends
// (viewer login, repository fields, __type probes, issue/PR reads, the five
// mutations, node(id:), cursor pagination, operation batching).
//
// Determinism: no wall clock, no randomness. All timestamps come from
// ctx.store.clock; all ids come from store counters or content-derived values.
// Node 22 type stripping: erasable syntax only (no enums, namespaces,
// parameter properties or `import =`).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Ctx, type Issue, type IssueComment, type Label, type Pull, type Repo, type Store, type User } from './store.ts';
import { isAuthorized, parseJsonBody, readBody, sendError, sendJson } from './util.ts';

// ---------------------------------------------------------------------------------------------------------
// Schema table: type -> field -> GraphQL type name. A field present here is
// "known" (resolves, or null when unimplemented); a field absent here is an
// error naming the field. Introspection field lists derive from this table.
// ---------------------------------------------------------------------------------------------------------

const SCHEMA: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'User', repository: 'Repository', node: 'Node', user: 'User',
    search: 'SearchResultItemConnection', rateLimit: 'RateLimit',
    __type: '__Type', __schema: '__Schema', __typename: 'String',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload', __typename: 'String',
  },
  Node: { id: 'ID', __typename: 'String' },
  SearchResultItem: { __typename: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: 'String', url: 'URI', createdAt: 'DateTime',
    updatedAt: 'DateTime', isPrivate: 'Boolean', fork: 'Boolean', __typename: 'String',
  },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String', url: 'URI',
    createdAt: 'DateTime', updatedAt: 'DateTime', closedAt: 'DateTime', author: 'User',
    labels: 'LabelConnection', comments: 'IssueCommentConnection', assignees: 'UserConnection',
    milestone: 'Milestone', locked: 'Boolean', repository: 'Repository', __typename: 'String',
  },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState',
    files: 'PullRequestChangedFileConnection', url: 'URI', createdAt: 'DateTime',
    updatedAt: 'DateTime', closedAt: 'DateTime', mergedAt: 'DateTime', author: 'User',
    headRef: 'Ref', baseRef: 'Ref', isDraft: 'Boolean', changedFiles: 'Int',
    additions: 'Int', deletions: 'Int', __typename: 'String',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String', url: 'URI', __typename: 'String' },
  Ref: { id: 'ID', name: 'String', prefix: 'String', __typename: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  IssueCommentConnection: { nodes: '[IssueComment]', edges: '[IssueCommentEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  LabelConnection: { nodes: '[Label]', edges: '[LabelEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  UserConnection: { nodes: '[User]', edges: '[UserEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', edges: '[PullRequestChangedFileEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  SearchResultItemConnection: { nodes: '[SearchResultItem]', edges: '[SearchResultItemEdge]', pageInfo: 'PageInfo', totalCount: 'Int', __typename: 'String' },
  IssueEdge: { node: 'Issue', cursor: 'String', __typename: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String', __typename: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String', __typename: 'String' },
  LabelEdge: { node: 'Label', cursor: 'String', __typename: 'String' },
  UserEdge: { node: 'User', cursor: 'String', __typename: 'String' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String', __typename: 'String' },
  SearchResultItemEdge: { node: 'SearchResultItem', cursor: 'String', __typename: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String', __typename: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String', url: 'URI', __typename: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'DateTime', updatedAt: 'DateTime', url: 'URI', __typename: 'String' },
  PullRequestChangedFile: { path: 'String', __typename: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String', __typename: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String', __typename: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String', __typename: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String', __typename: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String', __typename: 'String' },
  RateLimit: { limit: 'Int', remaining: 'Int', resetAt: 'DateTime', used: 'Int', __typename: 'String' },
  Milestone: { id: 'ID', number: 'Int', title: 'String', __typename: 'String' },
  __Type: {
    name: 'String', kind: '__TypeKind', description: 'String', fields: '[__Field]',
    enumValues: '[__EnumValue]', inputFields: '[__InputValue]', interfaces: '[__Type]',
    possibleTypes: '[__Type]', ofType: '__Type', __typename: 'String',
  },
  __Field: { name: 'String', description: 'String', args: '[__InputValue]', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String', __typename: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String', __typename: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String', __typename: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '[__Type]', directives: '[__Directive]', __typename: 'String' },
  __Directive: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]', __typename: 'String' },
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI', 'REGISTRY'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A resolved GraphQL object: its concrete type plus its backing data. */
interface Obj {
  __typename: string;
  [key: string]: unknown;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Opaque Relay global id: base64("<Kind>:<part>:..."). */
function gid(kind: string, ...parts: (string | number)[]): string {
  return b64([kind, ...parts.map(String)].join(':'));
}

function ungid(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const segs = text.split(':');
  const kind = segs[0];
  if (kind === undefined || kind === '' || segs.length < 2) return null;
  if (!['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label', 'Ref'].includes(kind)) return null;
  return { kind, parts: segs.slice(1) };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', repo, pull };
}

function labelObj(repo: Repo, label: Label): Obj {
  return { __typename: 'Label', repo, label };
}

function commentObj(repo: Repo, issue: Issue, comment: IssueComment): Obj {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function userObj(user: User): Obj {
  return { __typename: 'User', user };
}

function findRepoByDbId(store: Store, dbId: number): Repo | null {
  if (!Number.isFinite(dbId)) return null;
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findRepoByGid(store: Store, id: unknown): Repo | null {
  const parsed = ungid(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return findRepoByDbId(store, Number(parsed.parts[0]));
}

function findIssueByGid(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const parsed = ungid(id);
  if (parsed === null || parsed.kind !== 'Issue' || parsed.parts.length < 2) return null;
  const repo = findRepoByDbId(store, Number(parsed.parts[0]));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(parsed.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGid(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  const parsed = ungid(id);
  if (parsed === null || parsed.kind !== 'PullRequest' || parsed.parts.length < 2) return null;
  const repo = findRepoByDbId(store, Number(parsed.parts[0]));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(parsed.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------------------------------------
// GraphQL document parser (tokenizer + recursive descent). Supports operations,
// variables, fragments (named + inline), aliases, directives, input objects.
// ---------------------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'ellipsis' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        let j = i + 3;
        let out = '';
        while (j < n && !src.startsWith('"""', j)) {
          if (src.startsWith('\\"\\"\\"', j)) {
            out += '"""';
            j += 4;
          } else {
            out += src[j];
            j++;
          }
        }
        tokens.push({ kind: 'string', value: out });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1] as string;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j] as string;
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && (src[j] as string) >= '0' && (src[j] as string) <= '9') j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < n && (src[j] as string) >= '0' && (src[j] as string) <= '9') j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && (src[j] as string) >= '0' && (src[j] as string) <= '9') j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j] as string)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VarDefNode {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: string;
  name: string | null;
  varDefs: VarDefNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos: number;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos++;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected "${value}" but got "${t.value}"`);
  }

  expectName(expected?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected a name but got "${t.value}"`);
    if (expected !== undefined && t.value !== expected) throw new Error(`Expected "${expected}" but got "${t.value}"`);
    return t.value;
  }

  parseType(): string {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName();
    let out = name;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  parseValue(): ValueNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: t.value };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: t.value };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated list value');
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated object value');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected token "${t.value}" where a value was expected`);
  }

  parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated argument list');
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.next();
    }
    return args;
  }

  parseDirectives(): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      out.push({ name, args: this.parseArguments() });
    }
    return out;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'ellipsis') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        const name = this.expectName();
        return { kind: 'spread', name, directives: this.parseDirectives() };
      }
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  parseVarDefs(): VarDefNode[] {
    const out: VarDefNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated variable definitions');
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        // Variable-definition directives, if any, are skipped.
        this.parseDirectives();
        out.push({ name, defaultValue });
      }
      this.next();
    }
    return out;
  }

  parseOperation(): OperationNode {
    const operation = this.expectName();
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.expectName();
    const varDefs = this.parseVarDefs();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, varDefs, directives, selectionSet };
  }

  parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, directives, selectionSet };
  }
}

function parseDocument(src: string): DocumentNode {
  const parser = new Parser(tokenize(src));
  const doc: DocumentNode = { operations: [], fragments: new Map() };
  while (parser.peek().kind !== 'eof') {
    const t = parser.peek();
    if (t.kind === 'punct' && t.value === '{') {
      doc.operations.push({
        kind: 'operation', operation: 'query', name: null, varDefs: [], directives: [],
        selectionSet: parser.parseSelectionSet(),
      });
    } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      doc.operations.push(parser.parseOperation());
    } else if (t.kind === 'name' && t.value === 'fragment') {
      const frag = parser.parseFragment();
      doc.fragments.set(frag.name, frag);
    } else {
      throw new Error(`Unexpected token "${t.value}" in GraphQL document`);
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------------------
// Value evaluation and execution.
// ---------------------------------------------------------------------------------------------------------

interface GqlErrorOut {
  message: string;
  path?: (string | number)[];
}

function valueFromAst(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name] !== undefined ? vars[node.name] : null;
    case 'int':
      return parseInt(node.value, 10);
    case 'float':
      return parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueFromAst(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromAst(f.value, vars);
      return out;
    }
  }
}

function evalArgs(args: ArgumentNode[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = valueFromAst(a.value, vars);
  return out;
}

function directivesSkip(directives: DirectiveNode[], vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const args = evalArgs(d.args, vars);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if === false) return true;
  }
  return false;
}

function typeMatches(concrete: string, condition: string): boolean {
  if (condition === concrete) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].includes(concrete);
  return false;
}

function baseTypeName(typeStr: string): string {
  return typeStr.replace(/[\[\]!]/g, '');
}

function isScalarOrEnum(typeStr: string): boolean {
  const base = baseTypeName(typeStr);
  return SCALARS.has(base) || ENUM_VALUES[base] !== undefined;
}

function coerceValue(
  fieldType: string,
  raw: unknown,
  subSel: SelectionNode[] | null,
  vars: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  errors: GqlErrorOut[],
  path: (string | number)[],
  store: Store,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (fieldType.startsWith('[')) {
    if (!Array.isArray(raw)) return null;
    const inner = fieldType.slice(1, -1).replace(/!$/u, '');
    return raw.map((el, idx) => {
      if (isScalarOrEnum(inner)) return el;
      if (subSel === null) return el;
      return executeSelectionSet(inner, el as Obj, subSel, vars, fragments, errors, [...path, idx], store);
    });
  }
  if (isScalarOrEnum(fieldType)) return raw;
  if (subSel === null) return raw;
  return executeSelectionSet(fieldType, raw as Obj, subSel, vars, fragments, errors, path, store);
}

function executeSelectionSet(
  declaredType: string,
  value: Obj,
  selections: SelectionNode[],
  vars: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  errors: GqlErrorOut[],
  path: (string | number)[],
  store: Store,
): Record<string, unknown> {
  const concrete = value.__typename;
  const result: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (directivesSkip(sel.directives, vars)) continue;
      const frag = fragments.get(sel.name);
      if (frag === undefined) continue;
      if (!typeMatches(concrete, frag.typeCondition)) continue;
      const sub = executeSelectionSet(frag.typeCondition, value, frag.selectionSet, vars, fragments, errors, path, store);
      Object.assign(result, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (directivesSkip(sel.directives, vars)) continue;
      if (sel.typeCondition !== null && !typeMatches(concrete, sel.typeCondition)) continue;
      const sub = executeSelectionSet(
        sel.typeCondition ?? declaredType, value, sel.selectionSet, vars, fragments, errors, path, store,
      );
      Object.assign(result, sub);
      continue;
    }
    if (directivesSkip(sel.directives, vars)) continue;
    const responseKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      result[responseKey] = concrete;
      continue;
    }
    const declaredFields = SCHEMA[declaredType];
    const concreteFields = SCHEMA[concrete];
    const fieldType =
      (declaredFields !== undefined ? declaredFields[sel.name] : undefined) ??
      (concreteFields !== undefined ? concreteFields[sel.name] : undefined);
    if (fieldType === undefined) {
      errors.push({
        message: `Cannot query field "${sel.name}" on type "${declaredType}".`,
        path: [...path, responseKey],
      });
      result[responseKey] = null;
      continue;
    }
    const args = evalArgs(sel.args, vars);
    let raw: unknown;
    try {
      raw = resolveField(concrete, sel.name, value, args, store);
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: [...path, responseKey],
      });
      result[responseKey] = null;
      continue;
    }
    result[responseKey] = coerceValue(fieldType, raw, sel.selectionSet, vars, fragments, errors, [...path, responseKey], store);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Connections, cursors, pagination.
// ---------------------------------------------------------------------------------------------------------

function cursorFor(w: Obj): string {
  switch (w.__typename) {
    case 'Issue':
      return b64(`cursor:${(w.issue as Issue).number}`);
    case 'PullRequest':
      return b64(`cursor:${(w.pull as Pull).number}`);
    case 'IssueComment':
      return b64(`cursor:${(w.comment as IssueComment).id}`);
    case 'Label':
      return b64(`cursor:${(w.label as Label).id}`);
    case 'User':
      return b64(`cursor:${(w.user as User).id}`);
    case 'PullRequestChangedFile':
      return b64(`cursor:${String(w.path)}`);
    default:
      return b64('cursor:0');
  }
}

function emptyPageInfo(): Obj {
  return { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
}

function pageInfoFor(page: Obj[], start: number, total: number): Obj {
  return {
    __typename: 'PageInfo',
    hasNextPage: start + page.length < total,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorFor(page[0] as Obj) : null,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1] as Obj) : null,
  };
}

function makeConnection(connType: string, page: Obj[], pageInfo: Obj, totalCount: number): Obj {
  return {
    __typename: connType,
    nodes: page,
    cursors: page.map((w) => cursorFor(w)),
    pageInfo,
    totalCount,
  };
}

function paginate(wrappers: Obj[], args: Record<string, unknown>, connType: string): Obj {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const idx = wrappers.findIndex((w) => cursorFor(w) === after);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const first = typeof args.first === 'number' ? args.first : wrappers.length;
  const page = first < 0 ? [] : wrappers.slice(start, start + first);
  return makeConnection(connType, page, pageInfoFor(page, start, wrappers.length), wrappers.length);
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Obj {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  if (orderBy !== null) {
    const field = String(orderBy.field ?? 'CREATED_AT');
    const dir = String(orderBy.direction ?? 'ASC') === 'DESC' ? -1 : 1;
    list.sort((a, b) => {
      let cmp = 0;
      if (field === 'UPDATED_AT') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
      else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
      else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
      if (cmp === 0) cmp = a.number - b.number;
      return cmp * dir;
    });
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  return paginate(list.map((issue) => issueObj(repo, issue)), args, 'IssueConnection');
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const list = [...repo.pulls.values()]
    .filter((pull) => pull.state === 'open')
    .sort((a, b) => a.number - b.number);
  return paginate(list.map((pull) => pullObj(repo, pull)), args, 'PullRequestConnection');
}

// ---------------------------------------------------------------------------------------------------------
// Pull-request changed files: diff the head tree against the base tree.
// ---------------------------------------------------------------------------------------------------------

function commitTreeSha(repo: Repo, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const m = /^tree ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m === null ? null : (m[1] as string);
}

function treeMap(repo: Repo, treeSha: string | null, prefix: string, out: Map<string, string>): Map<string, string> {
  if (treeSha === null) return out;
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  const data = obj.data;
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    off = nul + 21;
    if (mode === '40000' || mode === '040000') treeMap(repo, sha, `${prefix}${name}/`, out);
    else out.set(`${prefix}${name}`, sha);
  }
  return out;
}

function prChangedPaths(repo: Repo, pull: Pull): string[] {
  const headTree = pull.head.sha === '' ? new Map<string, string>() : treeMap(repo, commitTreeSha(repo, pull.head.sha), '', new Map());
  const baseTree = pull.base.sha === '' ? new Map<string, string>() : treeMap(repo, commitTreeSha(repo, pull.base.sha), '', new Map());
  const out: string[] = [];
  for (const [path, sha] of headTree) {
    if (baseTree.get(path) !== sha) out.push(path);
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Introspection.
// ---------------------------------------------------------------------------------------------------------

function kindOf(name: string): string {
  if (ENUM_VALUES[name] !== undefined) return 'ENUM';
  if (name === 'Node' || name === 'SearchResultItem') return 'INTERFACE';
  if (name.endsWith('Input')) return 'INPUT_OBJECT';
  return 'OBJECT';
}

function typeRef(name: string): Obj {
  return { __typename: '__Type', name, kind: kindOf(name), description: null, fields: null, enumValues: null, inputFields: null, interfaces: null, possibleTypes: null, ofType: null };
}

function makeFieldInfo(name: string, typeStr: string): Obj {
  return {
    __typename: '__Field', name, description: null, args: [], type: typeRef(baseTypeName(typeStr)),
    isDeprecated: false, deprecationReason: null,
  };
}

function makeTypeInfo(name: string): Obj | null {
  const fields = SCHEMA[name];
  const enumVals = ENUM_VALUES[name];
  if (fields === undefined && enumVals === undefined) return null;
  const obj: Obj = {
    __typename: '__Type', name, kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : kindOf(name),
    description: null, fields: null, enumValues: null, inputFields: null, interfaces: null,
    possibleTypes: null, ofType: null,
  };
  if (fields !== undefined) {
    obj.fields = Object.keys(fields)
      .filter((f) => f !== '__typename')
      .map((f) => makeFieldInfo(f, fields[f] as string));
  }
  if (enumVals !== undefined) {
    obj.enumValues = enumVals.map((v) => ({
      __typename: '__EnumValue', name: v, description: null, isDeprecated: false, deprecationReason: null,
    }));
  }
  return obj;
}

// ---------------------------------------------------------------------------------------------------------
// Field resolvers.
// ---------------------------------------------------------------------------------------------------------

function edgeTypeFor(connType: string): string {
  return connType.endsWith('Connection') ? `${connType.slice(0, -'Connection'.length)}Edge` : 'Edge';
}

function resolveField(concrete: string, field: string, value: Obj, args: Record<string, unknown>, store: Store): unknown {
  switch (concrete) {
    case 'Query':
      return resolveQuery(field, args, store);
    case 'Mutation':
      return resolveMutation(field, args, store);
    case 'Repository':
      return resolveRepository(field, value, args);
    case 'Issue':
      return resolveIssue(field, value, args);
    case 'PullRequest':
      return resolvePull(field, value, args);
    case 'User': {
      const user = value.user as User;
      if (field === 'id') return gid('User', user.id);
      if (field === 'login') return user.login;
      if (field === 'name') return user.name;
      if (field === 'email') return user.email;
      if (field === 'url') return `https://github.com/${user.login}`;
      return null;
    }
    case 'Ref': {
      if (field === 'id') return value.id;
      if (field === 'name') return value.name;
      if (field === 'prefix') return value.prefix;
      return null;
    }
    case 'Label': {
      const repo = value.repo as Repo;
      const label = value.label as Label;
      if (field === 'id') return gid('Label', repo.id, label.id);
      if (field === 'name') return label.name;
      if (field === 'color') return label.color;
      if (field === 'description') return label.description;
      if (field === 'url') return label.url;
      return null;
    }
    case 'IssueComment': {
      const repo = value.repo as Repo;
      const issue = value.issue as Issue;
      const comment = value.comment as IssueComment;
      if (field === 'id') return gid('IssueComment', repo.id, issue.number, comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return userObj(comment.user);
      if (field === 'createdAt') return comment.created_at;
      if (field === 'updatedAt') return comment.updated_at;
      if (field === 'url') return comment.url;
      return null;
    }
    default:
      break;
  }
  // Connections (nodes/edges/pageInfo/totalCount) and payloads / introspection
  // objects store their fields as plain properties.
  if (field === 'edges' && Array.isArray(value.nodes)) {
    const cursors = Array.isArray(value.cursors) ? (value.cursors as string[]) : [];
    const edgeType = edgeTypeFor(concrete);
    return (value.nodes as Obj[]).map((node, i) => ({
      __typename: edgeType, node, cursor: cursors[i] !== undefined ? cursors[i] : null,
    }));
  }
  if (Object.prototype.hasOwnProperty.call(value, field)) return value[field];
  return null;
}

function resolveQuery(field: string, args: Record<string, unknown>, store: Store): unknown {
  switch (field) {
    case 'viewer':
      return userObj(VIEWER);
    case 'repository': {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = store.getRepo(args.owner, args.name);
      return repo === undefined ? null : repoObj(repo);
    }
    case 'node':
      return resolveNode(args.id, store);
    case 'user':
      return typeof args.login === 'string' && args.login === VIEWER.login ? userObj(VIEWER) : null;
    case 'search':
      return { __typename: 'SearchResultItemConnection', nodes: [], cursors: [], pageInfo: emptyPageInfo(), totalCount: 0 };
    case 'rateLimit':
      return { __typename: 'RateLimit', limit: 5000, remaining: 5000, resetAt: store.clock.nowIso(), used: 0 };
    case '__type':
      return typeof args.name === 'string' ? makeTypeInfo(args.name) : null;
    case '__schema':
      return {
        __typename: '__Schema',
        queryType: typeRef('Query'),
        mutationType: typeRef('Mutation'),
        subscriptionType: null,
        types: Object.keys(SCHEMA).map((n) => makeTypeInfo(n)).filter((t) => t !== null),
        directives: [],
      };
    default:
      return null;
  }
}

function resolveNode(id: unknown, store: Store): Obj | null {
  const parsed = ungid(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoByDbId(store, Number(parsed.parts[0]));
    return repo === null ? null : repoObj(repo);
  }
  if (parsed.kind === 'Issue') {
    const found = findIssueByGid(store, id);
    return found === null ? null : issueObj(found.repo, found.issue);
  }
  if (parsed.kind === 'PullRequest') {
    const found = findPullByGid(store, id);
    return found === null ? null : pullObj(found.repo, found.pull);
  }
  if (parsed.kind === 'User') {
    return Number(parsed.parts[0]) === VIEWER.id ? userObj(VIEWER) : null;
  }
  if (parsed.kind === 'IssueComment') {
    if (parsed.parts.length < 3) return null;
    const found = findIssueByGid(store, gid('Issue', parsed.parts[0] as string, parsed.parts[1] as string));
    if (found === null) return null;
    const comment = found.issue.comments.find((c) => c.id === Number(parsed.parts[2]));
    return comment === undefined ? null : commentObj(found.repo, found.issue, comment);
  }
  return null;
}

function resolveRepository(field: string, value: Obj, args: Record<string, unknown>): unknown {
  const repo = value.repo as Repo;
  switch (field) {
    case 'id':
      return gid('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repo.full_name;
    case 'owner':
      return userObj(VIEWER);
    case 'defaultBranchRef':
      return { __typename: 'Ref', id: gid('Ref', repo.id, repo.default_branch), name: repo.default_branch, prefix: 'refs/heads/' };
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'url':
      return repo.url;
    case 'createdAt':
      return repo.created_at;
    case 'updatedAt':
      return repo.updated_at;
    case 'isPrivate':
      return repo.private;
    case 'fork':
      return repo.fork;
    case 'issue': {
      if (typeof args.number !== 'number') return null;
      const issue = repo.issues.get(args.number);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    case 'issues':
      return issueConnection(repo, args);
    case 'pullRequests':
      return pullConnection(repo, args);
    case 'pullRequest': {
      if (typeof args.number !== 'number') return null;
      const pull = repo.pulls.get(args.number);
      return pull === undefined ? null : pullObj(repo, pull);
    }
    default:
      return null;
  }
}

function resolveIssue(field: string, value: Obj, args: Record<string, unknown>): unknown {
  const repo = value.repo as Repo;
  const issue = value.issue as Issue;
  switch (field) {
    case 'id':
      return gid('Issue', repo.id, issue.number);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'body':
      return issue.body;
    case 'url':
      return issue.url;
    case 'createdAt':
      return issue.created_at;
    case 'updatedAt':
      return issue.updated_at;
    case 'closedAt':
      return issue.closed_at;
    case 'author':
      return userObj(issue.user);
    case 'labels':
      return paginate(issue.labels.map((l) => labelObj(repo, l)), args, 'LabelConnection');
    case 'comments':
      return paginate(issue.comments.map((c) => commentObj(repo, issue, c)), args, 'IssueCommentConnection');
    case 'assignees':
      return paginate(issue.assignee !== null ? [userObj(issue.assignee)] : [], args, 'UserConnection');
    case 'milestone':
      return null;
    case 'locked':
      return issue.locked;
    case 'repository':
      return repoObj(repo);
    default:
      return null;
  }
}

function resolvePull(field: string, value: Obj, args: Record<string, unknown>): unknown {
  const repo = value.repo as Repo;
  const pull = value.pull as Pull;
  switch (field) {
    case 'id':
      return gid('PullRequest', repo.id, pull.number);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.head.ref;
    case 'baseRefName':
      return pull.base.ref;
    case 'mergeable':
      return pull.mergeable === true ? 'MERGEABLE' : pull.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
    case 'files': {
      const nodes = prChangedPaths(repo, pull).map((p) => ({ __typename: 'PullRequestChangedFile', path: p }));
      return paginate(nodes, args, 'PullRequestChangedFileConnection');
    }
    case 'url':
      return pull.url;
    case 'createdAt':
      return pull.created_at;
    case 'updatedAt':
      return pull.updated_at;
    case 'closedAt':
      return pull.closed_at;
    case 'mergedAt':
      return pull.merged_at;
    case 'author':
      return userObj(pull.user);
    case 'headRef':
      return { __typename: 'Ref', id: gid('Ref', repo.id, pull.head.ref), name: pull.head.ref, prefix: 'refs/heads/' };
    case 'baseRef':
      return { __typename: 'Ref', id: gid('Ref', repo.id, pull.base.ref), name: pull.base.ref, prefix: 'refs/heads/' };
    case 'isDraft':
      return false;
    case 'changedFiles':
      return prChangedPaths(repo, pull).length;
    case 'additions':
      return null;
    case 'deletions':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Mutations. Writes use the store's own Issue/Pull/IssueComment shapes so the
// REST surface reads them back identically.
// ---------------------------------------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function clientMutationIdOf(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function resolveMutation(field: string, args: Record<string, unknown>, store: Store): unknown {
  switch (field) {
    case 'createIssue': {
      const input = toRecord(args.input);
      const repo = findRepoByGid(store, input.repositoryId);
      if (repo === null) throw new Error('createIssue: repository not found');
      const now = store.clock.tickIso();
      const number = repo.nextIssueNumber++;
      const issue: Issue = {
        id: store.nextGlobalId(),
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
        comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
      };
      repo.issues.set(number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: clientMutationIdOf(input) };
    }
    case 'closeIssue': {
      const input = toRecord(args.input);
      const found = findIssueByGid(store, input.issueId);
      if (found === null) throw new Error('closeIssue: issue not found');
      const now = store.clock.tickIso();
      found.issue.state = 'closed';
      found.issue.closed_at = now;
      found.issue.updated_at = now;
      return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: clientMutationIdOf(input) };
    }
    case 'createPullRequest': {
      const input = toRecord(args.input);
      const repo = findRepoByGid(store, input.repositoryId);
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.default_branch;
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      const now = store.clock.tickIso();
      const number = repo.nextPullNumber++;
      const pull: Pull = {
        id: store.nextGlobalId(),
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        head: { label: `${VIEWER.login}:${headRef}`, ref: headRef, sha: headSha, repo: { id: repo.id, full_name: repo.full_name } },
        base: { label: `${VIEWER.login}:${baseRef}`, ref: baseRef, sha: baseSha, repo: { id: repo.id, full_name: repo.full_name } },
        merged: false,
        mergeable: headSha !== '' && baseSha !== '' ? true : null,
        merge_commit_sha: null,
        user: VIEWER,
        created_at: now,
        updated_at: now,
        closed_at: null,
        merged_at: null,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}`,
      };
      repo.pulls.set(number, pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: clientMutationIdOf(input) };
    }
    case 'mergePullRequest': {
      const input = toRecord(args.input);
      const found = findPullByGid(store, input.pullRequestId);
      if (found === null) throw new Error('mergePullRequest: pull request not found');
      const now = store.clock.tickIso();
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.merged_at = now;
      found.pull.closed_at = now;
      found.pull.updated_at = now;
      found.pull.merge_commit_sha = found.pull.head.sha !== '' ? found.pull.head.sha : null;
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: clientMutationIdOf(input) };
    }
    case 'addComment': {
      const input = toRecord(args.input);
      const found = findIssueByGid(store, input.subjectId);
      if (found === null) throw new Error('addComment: subject issue not found');
      const now = store.clock.tickIso();
      const commentId = found.repo.nextCommentId++;
      const comment: IssueComment = {
        id: commentId,
        body: typeof input.body === 'string' ? input.body : '',
        user: VIEWER,
        created_at: now,
        updated_at: now,
        html_url: `https://github.com/${found.repo.owner}/${found.repo.name}/issues/${found.issue.number}#issuecomment-${commentId}`,
        url: `/api/v3/repos/${found.repo.owner}/${found.repo.name}/issues/comments/${commentId}`,
      };
      found.issue.comments.push(comment);
      const node = commentObj(found.repo, found.issue, comment);
      const edge: Obj = { __typename: 'IssueCommentEdge', node, cursor: cursorFor(node) };
      return { __typename: 'AddCommentPayload', commentEdge: edge, clientMutationId: clientMutationIdOf(input) };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Operation execution and the HTTP handler.
// ---------------------------------------------------------------------------------------------------------

interface ExecResult {
  data: Record<string, unknown> | null;
  errors?: GqlErrorOut[];
}

function executeOperation(doc: DocumentNode, op: OperationNode, variables: Record<string, unknown>, store: Store): ExecResult {
  const vars: Record<string, unknown> = {};
  for (const vd of op.varDefs) {
    if (Object.prototype.hasOwnProperty.call(variables, vd.name) && variables[vd.name] !== undefined) {
      vars[vd.name] = variables[vd.name];
    } else if (vd.defaultValue !== null) {
      vars[vd.name] = valueFromAst(vd.defaultValue, vars);
    } else {
      vars[vd.name] = null;
    }
  }
  if (op.operation === 'subscription') {
    return { data: null, errors: [{ message: 'subscriptions are not supported' }] };
  }
  const errors: GqlErrorOut[] = [];
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Obj = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, op.selectionSet, vars, doc.fragments, errors, [], store);
  const out: ExecResult = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

function executeOne(entry: unknown, store: Store): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'each operation needs a query string' }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  let doc: DocumentNode;
  try {
    doc = parseDocument(entry.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse query' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in document' }] };
  }
  let op: OperationNode | undefined;
  if (operationName !== null) {
    op = doc.operations.find((o) => o.name === operationName);
  } else if (doc.operations.length === 1) {
    op = doc.operations[0];
  }
  if (op === undefined) {
    return {
      data: null,
      errors: [{
        message: operationName !== null
          ? `unknown operation "${operationName}"`
          : 'multiple operations in one document require an operationName',
      }],
    };
  }
  return executeOperation(doc, op, variables, store);
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(await readBody(req));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
    return true;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => executeOne(entry, ctx.store)));
    return true;
  }
  if (body !== null && typeof body === 'object') {
    sendJson(res, 200, executeOne(body, ctx.store));
    return true;
  }
  sendJson(res, 400, { errors: [{ message: 'request body must be a JSON object or array' }] });
  return true;
}
