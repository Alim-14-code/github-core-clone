// Shared low-level helpers for the forge: git hashing, pkt-line framing, and
// the small HTTP plumbing every endpoint leans on. Standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Content type used for every JSON answer we send. */
export const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------
// Hashing and compression
// ---------------------------------------------------------------------------

/** Hex SHA-1 digest of some bytes; the basis of every git object id. */
export function sha1(data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(data);
  return hash.digest('hex');
}

/** The object id of a git object: sha1 of "<type> <size>\0" + content. */
export function objectId(type: string, content: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${content.length}\0`, 'ascii');
  hash.update(content);
  return hash.digest('hex');
}

/** Inflate zlib-compressed bytes (loose objects and pack entries). */
export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

/**
 * Inflate one zlib stream and report how many input bytes it consumed.
 * `inflateSync` ignores trailing bytes, and with `{ info: true }` the
 * engine reports exactly how many input bytes it consumed, so one inflate
 * finds the stream's end — no trial-and-error, no thrown errors.
 * Returns null when the engine does not report a usable length (then the
 * caller falls back to the binary search).
 */
export function inflateCounted(data: Buffer): { data: Buffer; consumed: number } | null {
  const { buffer, engine } = inflateSync(data, { info: true });
  const consumed = (engine as unknown as { bytesWritten?: unknown }).bytesWritten;
  if (typeof consumed !== 'number' || !Number.isFinite(consumed) || consumed <= 0 || consumed > data.length) {
    return null;
  }
  return { data: buffer, consumed };
}

/** Deflate bytes with zlib (pack entries and loose objects). */
export function deflate(data: Buffer, level = 6): Buffer {
  return deflateSync(data, { level });
}

// ---------------------------------------------------------------------------
// pkt-line framing (git smart HTTP)
// ---------------------------------------------------------------------------

/** Encode a single pkt-line: four hex digits of length (self-inclusive) + body. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const totalLength = body.length + 4;
  const lengthPrefix = totalLength.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(lengthPrefix, 'ascii'), body]);
}

/** The flush packet: the four bytes "0000". */
export const FLUSH = Buffer.from('0000', 'ascii');

/** The delimiter packet ("0001") used in protocol v2 responses. */
export const DELIM = Buffer.from('0001', 'ascii');

/** The response-end packet ("0002") used in protocol v2 responses. */
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** What one pkt-line decodes to: raw payload, or a named control packet. */
export type PktLine = Buffer | 'FLUSH' | 'DELIM' | 'END';

const FLUSH_PACKET = 0;
const DELIM_PACKET = 1;
const END_PACKET = 2;

/**
 * Decode a buffer of pkt-lines. Control packets become the strings 'FLUSH',
 * 'DELIM' and 'END'. Throws when a length header or a payload is cut short,
 * or when the length header is not a number.
 */
export function readPktLines(buf: Buffer): Array<PktLine> {
  const lines: Array<PktLine> = [];
  let cursor = 0;
  while (cursor < buf.length) {
    if (cursor + 4 > buf.length) {
      throw new Error('truncated pkt-line length');
    }
    const rawLength = buf.subarray(cursor, cursor + 4).toString('ascii');
    const length = parseInt(rawLength, 16);
    if (!Number.isFinite(length) || length < 0) {
      throw new Error('bad pkt-line length');
    }
    cursor += 4;
    if (length === FLUSH_PACKET) {
      lines.push('FLUSH');
    } else if (length === DELIM_PACKET) {
      lines.push('DELIM');
    } else if (length === END_PACKET) {
      lines.push('END');
    } else {
      const payloadLength = length - 4;
      if (cursor + payloadLength > buf.length) {
        throw new Error('truncated pkt-line');
      }
      lines.push(buf.subarray(cursor, cursor + payloadLength));
      cursor += payloadLength;
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

/** Slurp a request body into a Buffer; rejects past `maxBytes` (default 256 MiB). */
export function readBody(req: IncomingMessage, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pieces: Buffer[] = [];
    let seen = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBytes) {
        fail(new Error('request body too large'));
        req.destroy();
        return;
      }
      pieces.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(pieces));
      }
    });
    req.on('error', fail);
  });
}

/**
 * Parse a JSON request body. An empty body parses to null; malformed JSON
 * throws the usual SyntaxError from JSON.parse.
 */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text.length === 0) return null;
  return JSON.parse(text);
}

/** The path portion of a request URL; '/' when the URL will not parse. */
const urlCache = new WeakMap<IncomingMessage, URL>();

function parsedUrl(req: IncomingMessage): URL {
  const cached = urlCache.get(req);
  if (cached !== undefined) return cached;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  urlCache.set(req, url);
  return url;
}

export function pathOf(req: IncomingMessage): string {
  return parsedUrl(req).pathname;
}

/** The query parameters of a request URL; empty when the URL will not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  return parsedUrl(req).searchParams;
}

/** Percent-decode a single path segment; null when the escape is invalid. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * True when the request presents the suite's bearer token. When no token is
 * configured in the environment, any non-empty bearer token is accepted.
 */
export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const bearer = /^Bearer\s+(.+)$/.exec(header);
  if (bearer === null) return false;
  const presented = bearer[1].trim();
  if (presented === '') return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected === '') return true;
  return presented === expected;
}

// ---------------------------------------------------------------------------
// HTTP response helpers and error plumbing
// ---------------------------------------------------------------------------

/** A small error carrier: an HTTP status plus a human-readable message. */
export interface HttpError {
  status: number;
  message: string;
}

export function httpError(status: number, message: string): HttpError {
  return { status, message };
}

export function isHttpError(value: unknown): value is HttpError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as HttpError;
  return typeof candidate.status === 'number' && typeof candidate.message === 'string';
}

/**
 * Answer with JSON. `extraHeaders` are merged beside content-type and
 * content-length. The body is always terminated with a newline.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

/** Answer with a JSON `{message}` error body. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, status, { message }, extraHeaders);
}

/** A fresh request id from a shared counter object: `req-1`, `req-2`, ... */
export function nextRequestId(seq: { value: number }): string {
  seq.value += 1;
  return `req-${seq.value}`;
}
