// Small shared helpers: hashing, pkt-line framing, HTTP request/response plumbing.
// Node standard library only (node:crypto, node:zlib, node:http).

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** SHA-1 hex of a buffer (git object ids). */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a "<type> <size>\0<content>" object. */
export function objectId(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, content]));
}

/** zlib-inflate a buffer (loose objects, pack entries). */
export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

/** zlib-deflate a buffer (pack entries, loose objects). */
export function deflate(data: Buffer, level = 6): Buffer {
  return deflateSync(data, { level });
}

/** Encode one pkt-line: 4 hex length digits + payload (length includes the 4 digits). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** The pkt-line flush packet ("0000"). */
export const FLUSH = Buffer.from('0000', 'ascii');

/** The pkt-line delimiter packet ("0001") used by protocol v2. */
export const DELIM = Buffer.from('0001', 'ascii');

/** The pkt-line response-end packet ("0002") used by protocol v2. */
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/**
 * Split a buffer of pkt-lines into payloads. Returns the payloads and the offset just past the
 * last complete line; a trailing flush (0000) yields a null entry, a delimiter (0001) yields the
 * string 'DELIM', a response-end (0002) yields 'END'. Throws on a truncated line.
 */
export function readPktLines(buf: Buffer): Array<Buffer | 'FLUSH' | 'DELIM' | 'END'> {
  const out: Array<Buffer | 'FLUSH' | 'DELIM' | 'END'> = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push('FLUSH');
      off += 4;
    } else if (len === 1) {
      out.push('DELIM');
      off += 4;
    } else if (len === 2) {
      out.push('END');
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line');
      out.push(buf.subarray(off + 4, off + len));
      off += len;
    }
  }
  return out;
}

/** Read a request body fully (Buffer). Rejects over `maxBytes` (default 256 MiB). */
export function readBody(req: IncomingMessage, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null when the body is empty, throws on malformed JSON. */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

export interface HttpError {
  status: number;
  message: string;
}

export function httpError(status: number, message: string): HttpError {
  return { status, message };
}

export function isHttpError(value: unknown): value is HttpError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HttpError).status === 'number' &&
    typeof (value as HttpError).message === 'string'
  );
}

/** Send a JSON response. `extraHeaders` go beside content-type and content-length. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

/** Send a JSON error body `{message}`. */
export function sendError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extraHeaders);
}

/** The path of a request URL, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Query parameters of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Percent-decode one path segment; returns null on a bad escape. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** True when the request carries the suite's bearer token. */
export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1].trim();
  if (token === '') return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected === '') return true;
  return token === expected;
}

/** A fresh non-empty request id (deterministic: a counter). */
export function nextRequestId(seq: { value: number }): string {
  seq.value += 1;
  return `req-${seq.value}`;
}
