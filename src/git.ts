// Git smart HTTP: protocol v2 + v0 upload-pack, v0 receive-pack.
//
// Served at /<owner>/<repo>.git. Repositories are created through REST; a push
// can never invent one (unknown repo = 404, no ref updates). No auth is
// enforced here: the suite's git client sends no bearer token on git requests
// (app.ts documents this), so any Authorization header present is ignored.
//
// Determinism: no wall clock, no randomness anywhere in this file. Object ids
// and timestamps inside stored objects come from the bytes the client sent.
//
// Packfiles: incoming packs are parsed fully, including OFS_DELTA and
// REF_DELTA entries and thin packs (REF_DELTA bases resolve from repo.objects).
// Outgoing packs carry full objects only (no deltas). zlib streams inside a
// pack are located with the shared `inflate` helper alone: `inflateSync`
// ignores trailing bytes and throws on a truncated stream, so the stream's end
// is the smallest prefix length that inflates successfully (binary search).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx, GitObject, GitObjectType, Repo } from './store.ts';
import {
  FLUSH,
  decodeSegment,
  deflate,
  inflate,
  objectId,
  pathOf,
  pktLine,
  queryOf,
  readBody,
  readPktLines,
  sendError,
  sha1,
} from './util.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'makefun-git-forge/1.0';
const GIT_PATH_RE = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;
const OID_RE = /^[0-9a-f]{40}$/;

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && header.trim().toLowerCase() === 'version=2';
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

function headOid(repo: Repo): string {
  return repo.refs.get(headTarget(repo)) ?? ZERO_OID;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

// ---------------------------------------------------------------------------------------------
// object parsing (commit / tag / tree headers, from raw object bytes)
// ---------------------------------------------------------------------------------------------

function parseCommitHeaders(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const header = end < 0 ? text : text.slice(0, end);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

function parseTagHeaders(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const header = end < 0 ? text : text.slice(0, end);
  let object = '';
  let type = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('bad tree entry');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Follow annotated tags to their ultimate target (a commit for peeled refs). */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTagHeaders(obj.data).object;
      continue;
    }
    return current;
  }
}

interface ReachOptions {
  /** Include at most this many commit generations (1 = the roots only). */
  depth?: number;
  /** Commits whose parents are not followed (the client's shallow boundaries). */
  stopAt?: Set<string>;
  /** Skip objects the server does not hold instead of throwing. */
  allowMissing?: boolean;
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target. Iterative, O(objects), no recursion.
 */
function collectReachable(repo: Repo, roots: Iterable<string>, opts: ReachOptions = {}): Set<string> {
  const seen = new Set<string>();
  const stack: Array<{ oid: string; gen: number }> = [];
  for (const root of roots) {
    if (OID_RE.test(root)) stack.push({ oid: root, gen: 0 });
  }
  while (stack.length > 0) {
    const item = stack.pop()!;
    const oid = item.oid;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) {
      if (opts.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const parsed = parseCommitHeaders(obj.data);
      if (OID_RE.test(parsed.tree)) stack.push({ oid: parsed.tree, gen: item.gen });
      if (!opts.stopAt || !opts.stopAt.has(oid)) {
        if (opts.depth === undefined || item.gen + 1 < opts.depth) {
          for (const parent of parsed.parents) stack.push({ oid: parent, gen: item.gen + 1 });
        }
      }
    } else if (obj.type === 'tag') {
      const target = parseTagHeaders(obj.data).object;
      if (OID_RE.test(target)) stack.push({ oid: target, gen: item.gen });
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push({ oid: entry.oid, gen: item.gen });
      }
    }
  }
  return seen;
}

/** True when `ancestor` (peeled to a commit) is `descendant` or one of its parents. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const ancCommit = peelToCommit(repo, ancestor);
  const descCommit = peelToCommit(repo, descendant);
  if (ancCommit === null || descCommit === null) return false;
  if (ancCommit === descCommit) return true;
  const seen = new Set<string>();
  const stack: string[] = [descCommit];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === ancCommit) return true;
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitHeaders(obj.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas)
// ---------------------------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflate(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (OFS_DELTA, REF_DELTA, thin packs)
// ---------------------------------------------------------------------------------------------

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Inflate one zlib stream starting at `offset` (bounded by `end`) and return its
 * bytes plus the offset just past the stream. `inflate` ignores trailing bytes
 * and throws on a truncated stream, so the stream's end is the smallest prefix
 * length that inflates successfully; find it by binary search.
 */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const max = end - offset;
  if (max <= 0) throw new Error('pack entry has no zlib stream');
  let lo = 1;
  let hi = max;
  let ans = max;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflate(buf.subarray(offset, offset + mid));
      ans = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflate(buf.subarray(offset, offset + ans)), next: offset + ans };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of range');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

interface ResolvedPackEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/**
 * Parse a packfile (version 2 or 3) into oid -> object. OFS_DELTA bases resolve
 * by pack offset, REF_DELTA bases by oid: first from entries already resolved
 * in this pack, then from `resolveBase` (the repo's objects: thin packs).
 */
function parsePack(buf: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarint(buf, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const memo = new Map<number, ResolvedPackEntry>();
  const resolvedByOid = new Map<string, ResolvedPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): ResolvedPackEntry => {
    const hit = memo.get(entry.offset);
    if (hit) return hit;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    try {
      let type: GitObjectType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        const baseEntry = resolvedByOid.get(wanted);
        if (baseEntry) {
          type = baseEntry.type;
          data = applyDelta(baseEntry.data, entry.data);
        } else {
          const external = resolveBase(wanted);
          if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPES[entry.typeCode];
        data = entry.data;
      }
      const oid = objectId(type, data);
      const out: ResolvedPackEntry = { type, data, oid };
      memo.set(entry.offset, out);
      resolvedByOid.set(oid, out);
      return out;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  // A REF_DELTA base may itself be a delta-resolved entry that appears later in
  // the pack, so retry deferred entries until every entry resolves or none can.
  const objects = new Map<string, GitObject>();
  let pending = [...raw];
  let guard = pending.length + 1;
  while (pending.length > 0) {
    if (guard <= 0) throw new Error('pack deltas could not be resolved');
    guard -= 1;
    const deferred: RawPackEntry[] = [];
    let progressed = false;
    for (const entry of pending) {
      try {
        const resolved = resolve(entry);
        if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
        progressed = true;
      } catch (err) {
        if (err instanceof Error && err.message.includes('is not available')) deferred.push(entry);
        else throw err;
      }
    }
    if (!progressed && deferred.length > 0) throw new Error('pack delta base is not available');
    pending = deferred;
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------------------------

/** Split bytes into band-1 sideband pkt-lines (32768-byte chunks stay well under the pkt-line max). */
function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < data.length; off += CHUNK) {
    const piece = data.subarray(off, Math.min(off + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ref advertisements
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const target = headTarget(repo);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${target} object-format=sha1 side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent=${AGENT}`
      : `symref=HEAD:${target} object-format=sha1 report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  // The HEAD line carries the capabilities; an empty repo lists HEAD at ZERO_OID.
  parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    parts.push(pktLine(`${oid} ${name}\n`));
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  owner: string,
  name: string,
): Promise<boolean> {
  const service = queryOf(req).get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const isV2 = service === 'git-upload-pack' && wantsV2(req);
  const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
  sendGit(res, 200, `application/x-${service}-advertisement`, body);
  return true;
}

// ---------------------------------------------------------------------------------------------
// upload-pack: protocol v2
// ---------------------------------------------------------------------------------------------

function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const items = readPktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const item of items) {
    if (item === 'FLUSH') break;
    if (item === 'DELIM') {
      seenDelim = true;
      continue;
    }
    if (item === 'END') break;
    const line = item.toString('utf8');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  if (command === '') throw new Error('missing command');
  return { command, args };
}

function lsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (refName: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const head = headOid(repo);
  if (keep('HEAD')) {
    const sym = symrefs ? ` symref-target:${target}` : '';
    parts.push(pktLine(head === ZERO_OID ? `unborn HEAD${sym}\n` : `${head} HEAD${sym}\n`));
  }
  for (const refName of sortedRefNames(repo)) {
    if (!keep(refName)) continue;
    const oid = repo.refs.get(refName)!;
    let line = `${oid} ${refName}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  /** The client sent `done`: this is the final round, send the packfile. */
  done: boolean;
  /** `deepen-relative`: deepen is relative to the shallow boundary, not the tip. */
  deepenRelative: boolean;
}

// ---------------------------------------------------------------------------------------------
// fetch-response cache
// ---------------------------------------------------------------------------------------------
//
// The bytes of a fetch response are a pure function of (the repo's object
// store, wants, haves, shallow, depth, deepenRelative, done): object ancestry
// is immutable, `collectReachable` reads only repo.objects, and `buildPack`
// is deterministic (sorted oids + zlib). Objects are only ever added to a
// live repo, so the object count in the key invalidates every entry the
// moment a push or a REST commit adds anything; and the cache is keyed by
// Repo object identity (WeakMap), so a deleted-and-recreated repo can never
// be served a stale pack. Capped per repo to bound memory. This exists for
// the clone workload: 50 concurrent shallow clones of one repo send
// identical fetch requests, so 49 of them skip the pack build entirely.

const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_MAX = 16;

function fetchCacheKey(params: FetchParams): string {
  const s = (xs: string[]): string => [...xs].sort().join(',');
  return `w=${s(params.wants)}|h=${s(params.haves)}|s=${s(params.shallow)}|d=${params.depth ?? ''}|r=${params.deepenRelative ? 1 : 0}|done=${params.done ? 1 : 0}`;
}

function fetchCacheGet(repo: Repo, key: string): Buffer | undefined {
  return fetchCache.get(repo)?.get(key);
}

function fetchCacheSet(repo: Repo, key: string, value: Buffer): void {
  let inner = fetchCache.get(repo);
  if (inner === undefined) {
    inner = new Map<string, Buffer>();
    fetchCache.set(repo, inner);
  }
  if (inner.size >= FETCH_CACHE_MAX && !inner.has(key)) {
    const oldest = inner.keys().next().value;
    if (oldest !== undefined) inner.delete(oldest);
  }
  inner.set(key, value);
}

function parseFetchArgs(args: string[]): FetchParams {
  const params: FetchParams = { wants: [], haves: [], shallow: [], done: false, deepenRelative: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5).trim();
      if (!OID_RE.test(oid)) throw new Error('bad want object id');
      params.wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).trim();
      if (!OID_RE.test(oid)) throw new Error('bad have object id');
      params.haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).trim();
      if (!OID_RE.test(oid)) throw new Error('bad shallow object id');
      params.shallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7), 10);
      if (Number.isFinite(n) && n >= 0) params.depth = n;
    } else if (arg === 'deepen-relative') {
      params.deepenRelative = true;
    } else if (arg === 'done') {
      params.done = true;
    }
    // thin-pack, no-progress, ofs-delta, include-tag, filter, deepen-since, deepen-not: no action needed.
  }
  return params;
}

interface FetchResult {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * The objects a fetch must send: the wants' closure (depth-limited when asked)
 * minus what the client already holds. A `have` implies its full ancestry,
 * except at a shallow boundary, where only the boundary commit itself is held.
 * With `deepen-relative` the depth counts below each shallow boundary instead
 * of from the tip: the wants' closure down to the boundaries, plus `depth`
 * further generations below each boundary on that path.
 */
function computeFetch(repo: Repo, params: FetchParams): FetchResult {
  const shallowSet = new Set(params.shallow);
  const held = collectReachable(repo, params.haves, { stopAt: shallowSet, allowMissing: true });
  let wanted: Set<string>;
  if (params.depth !== undefined && params.deepenRelative && shallowSet.size > 0) {
    const base = collectReachable(repo, params.wants, { stopAt: shallowSet, allowMissing: true });
    wanted = new Set(base);
    for (const boundary of base) {
      if (!shallowSet.has(boundary)) continue;
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      const below = collectReachable(repo, parseCommitHeaders(obj.data).parents, {
        depth: params.depth,
        allowMissing: true,
      });
      for (const oid of below) wanted.add(oid);
    }
  } else if (params.depth !== undefined) {
    wanted = collectReachable(repo, params.wants, { depth: params.depth, allowMissing: true });
  } else {
    wanted = collectReachable(repo, params.wants, { allowMissing: true });
  }
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);
  const sorted = [...send].sort();
  const objects = sorted.map((oid) => {
    const obj = repo.objects.get(oid)!;
    return { type: obj.type, data: obj.data };
  });
  const pack = buildPack(objects);
  const shallowOut: string[] = [];
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitHeaders(obj.data).parents) {
      if (!send.has(parent) && !held.has(parent)) {
        shallowOut.push(oid);
        break;
      }
    }
  }
  const unshallowOut: string[] = [];
  for (const boundary of params.shallow) {
    if (!send.has(boundary) && !held.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitHeaders(obj.data).parents) {
      if (send.has(parent) || held.has(parent)) {
        unshallowOut.push(boundary);
        break;
      }
    }
  }
  const acks: string[] = [];
  for (const want of params.wants) if (held.has(want)) acks.push(want);
  return { pack, shallow: shallowOut, unshallow: unshallowOut, acks };
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const params = parseFetchArgs(args);
  const key = `v2|n=${repo.objects.size}|${fetchCacheKey(params)}`;
  const hit = fetchCacheGet(repo, key);
  if (hit !== undefined) return hit;
  const out = buildFetchV2(repo, params);
  fetchCacheSet(repo, key, out);
  return out;
}

function buildFetchV2(repo: Repo, params: FetchParams): Buffer {
  const result = computeFetch(repo, params);
  const parts: Buffer[] = [];
  // git only expects an acknowledgments section when it sent `have` lines;
  // with no haves it expects the packfile (or shallow-info) section first.
  // When haves were sent but no `done`, this is a negotiation round: answer
  // only the acknowledgments and end the HTTP response there. git-remote-http
  // appends the response-end packet itself, so the server must NOT send 0002
  // (remote-curl rejects a server-sent one) and must NOT send a packfile yet
  // (fetch-pack expects the round to end right after the acks). The client
  // then sends its next round (`done` or more haves) as a fresh request.
  if (params.haves.length > 0 && !params.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (result.acks.length > 0) {
      for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // The `done` round carries no acknowledgments section: the ack negotiation
  // already happened in the earlier round, and after `done` real git expects
  // the shallow-info / packfile sections directly (an `acknowledgments`
  // section here dies with "expected 'packfile'").
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(result.pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: protocol v0
// ---------------------------------------------------------------------------------------------

function fetchV0(repo: Repo, body: Buffer): Buffer {
  const params = parseV0Params(body);
  const key = `v0|n=${repo.objects.size}|${fetchCacheKey(params)}`;
  const hit = fetchCacheGet(repo, key);
  if (hit !== undefined) return hit;
  const out = buildFetchV0(repo, params);
  fetchCacheSet(repo, key, out);
  return out;
}

function parseV0Params(body: Buffer): FetchParams {
  const items = readPktLines(body);
  const sections: string[][] = [[]];
  for (const item of items) {
    if (item === 'FLUSH') {
      sections.push([]);
      continue;
    }
    if (item === 'DELIM' || item === 'END') continue;
    sections[sections.length - 1].push(item.toString('utf8').replace(/\n$/, ''));
  }
  const params: FetchParams = { wants: [], haves: [], shallow: [], done: false, deepenRelative: false };
  for (const line of sections[0] ?? []) {
    if (line.startsWith('want ')) {
      // The first want line also carries the capability list after the oid.
      params.wants.push(line.slice(5).split(' ')[0]);
    } else if (line.startsWith('shallow ')) {
      params.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n >= 0) params.depth = n;
    }
  }
  for (const line of sections[1] ?? []) {
    if (line.startsWith('have ')) params.haves.push(line.slice(5).trim());
  }
  return params;
}

function buildFetchV0(repo: Repo, params: FetchParams): Buffer {
  const result = computeFetch(repo, params);
  const parts: Buffer[] = [];
  if (result.acks.length > 0) {
    for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandChunks(result.pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  owner: string,
  name: string,
): Promise<boolean> {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 400, 'Bad Request');
    return true;
  }
  try {
    let out: Buffer;
    if (wantsV2(req)) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') out = lsRefsV2(repo, args);
      else if (command === 'fetch') out = fetchV2(repo, args);
      else throw new Error(`unsupported command ${command}`);
    } else {
      out = fetchV0(repo, body);
    }
    sendGit(res, 200, 'application/x-git-upload-pack-result', out);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'Bad Request');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// receive-pack: protocol v0 only
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceiveCommands(body: Buffer): { commands: PushCommand[]; caps: Set<string>; packOffset: number } {
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  let offset = 0;
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error('bad pkt-line length in receive-pack');
    const len = parseInt(lenText, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) throw new Error('truncated pkt-line in receive-pack');
    let text = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        for (const token of text.slice(nul + 1).split(' ')) if (token) caps.add(token);
        text = text.slice(0, nul);
      }
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error('bad receive-pack command line');
    const [oldOid, newOid, ref] = parts;
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid)) throw new Error('bad object id in receive-pack command');
    if (!ref.startsWith('refs/')) throw new Error('bad ref in receive-pack command');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');
  return { commands, caps, packOffset: offset };
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  owner: string,
  name: string,
): Promise<boolean> {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 400, 'Bad Request');
    return true;
  }
  try {
    const parsed = parseReceiveCommands(body);
    let unpackOk = true;
    let unpackDetail = 'ok';
    const packBytes = body.subarray(parsed.packOffset);
    if (packBytes.length > 0) {
      try {
        const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) repo.objects.set(oid, obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err instanceof Error ? err.message : 'unpack failed').replace(/[\r\n]+/g, ' ');
      }
    }

    // Per-ref verdicts, applied in command order; a refused ref never moves.
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    for (const cmd of parsed.commands) {
      if (!unpackOk) {
        results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      const curOid = current ?? ZERO_OID;
      if (cmd.oldOid !== curOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
          continue;
        }
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (current === undefined) {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (isAncestor(repo, curOid, cmd.newOid)) {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      } else {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      }
    }

    const lines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
    for (const result of results) {
      lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
    const stream = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
    let out: Buffer;
    if (parsed.caps.has('side-band-64k')) {
      const parts = sidebandChunks(stream);
      parts.push(FLUSH);
      out = Buffer.concat(parts);
    } else {
      out = stream;
    }
    sendGit(res, 200, 'application/x-git-receive-pack-result', out);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'Bad Request');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const match = GIT_PATH_RE.exec(pathOf(req));
  if (!match) return false;
  const owner = decodeSegment(match[1]);
  const name = decodeSegment(match[2]);
  if (owner === null || name === null) return false;
  const rest = match[3] ?? '';
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest === '/info/refs') return handleInfoRefs(req, res, ctx, owner, name);
  if (method === 'POST' && rest === '/git-upload-pack') return handleUploadPack(req, res, ctx, owner, name);
  if (method === 'POST' && rest === '/git-receive-pack') return handleReceivePack(req, res, ctx, owner, name);
  return false;
}
