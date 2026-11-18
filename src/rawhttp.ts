// Raw TCP HTTP/1.1 server for the forge: a minimal, allocation-light
// replacement for node:http on the request path.
//
// WHY: the benchmark is per-request latency on a throttled box, and the
// measured floor for node:http is ~134 us of server CPU per request even
// with a trivial handler (parser, IncomingMessage/ServerResponse
// allocation, stream machinery, socket writes). A hand-rolled parser over
// node:net answers the same requests for ~40 us. The leaders in this
// competition do exactly this (hand-rolled HTTP/1.1, zero-alloc hot path).
//
// SCOPE: this serves only what the suite's clients send — HTTP/1.0 and
// 1.1, origin-form targets, Content-Length and chunked bodies, keep-alive
// and Connection: close, Expect: 100-continue. Anything it cannot parse
// gets a 400 and the socket closed, exactly like a malformed request to
// node:http. It is NOT a general HTTP server.
//
// The handlers (app.ts dispatch and everything under src/) are untouched:
// they see a Readable request carrying the parsed body and a response
// object with exactly the surface they use (writeHead, end, destroy).
// Response bytes are assembled once and written with a single socket
// write per request.

import net from 'node:net';
import { STATUS_CODES } from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Largest request body accepted, matching util.ts readBody's cap. */
const MAX_BODY = 256 * 1024 * 1024;
/** Largest request head (request line + headers) accepted. */
const MAX_HEAD = 64 * 1024;

// ---------------------------------------------------------------------------
// Request / response adapters (the only surface the handlers touch)
// ---------------------------------------------------------------------------

/** A request: method, url, headers, and the parsed body as a stream. */
class RawRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[]>;
  readonly socket: net.Socket;

  constructor(socket: net.Socket, method: string, url: string, headers: Record<string, string | string[]>, body: Buffer) {
    super();
    this.socket = socket;
    this.method = method;
    this.url = url;
    this.headers = headers;
    if (body.length > 0) this.push(body);
    this.push(null);
  }

  // _read is a no-op: the whole body was pushed in the constructor.
  override _read(): void {}

  override destroy(error?: Error): this {
    // NOTE: deliberately does NOT destroy the socket. A Readable
    // auto-destroys itself after 'end' (autoDestroy), and readBody's
    // consumer path ends the stream on every POST — destroying the socket
    // here would kill the connection before the response is written.
    // Oversize bodies never reach readBody: the parser caps them and
    // closes the socket itself (see tryParse / MAX_BODY).
    super.destroy(error);
    return this;
  }
}

/** A response: buffers status/headers/body, flushes once on end(). */
class RawResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly socket: net.Socket;
  private readonly keepAlive: boolean;
  private readonly headMethod: boolean;
  private readonly onDone: (alive: boolean) => void;
  private readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private flushed = false;

  constructor(socket: net.Socket, keepAlive: boolean, headMethod: boolean, onDone: (alive: boolean) => void) {
    this.socket = socket;
    this.keepAlive = keepAlive;
    this.headMethod = headMethod;
    this.onDone = onDone;
  }

  setHeader(name: string, value: string | number | string[]): void {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  writeHead(status: number, headers?: Record<string, string | number | string[]>): void {
    if (this.writableEnded) return;
    this.statusCode = status;
    if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.headersSent = true;
  }

  end(data?: string | Buffer): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    if (data !== undefined) {
      this.chunks.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    }
    this.flush();
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }

  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const body = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    // HEAD answers carry the headers (and the content-length the handler
    // set) but no body bytes, exactly like node:http.
    const outBody = this.headMethod ? Buffer.alloc(0) : body;
    const status = this.statusCode;
    const reason = STATUS_CODES[status] ?? '';
    const lines: string[] = [`HTTP/1.1 ${status}${reason === '' ? '' : ` ${reason}`}`];
    let hasLength = false;
    for (const [name, value] of Object.entries(this.headers)) {
      if (name === 'content-length') hasLength = true;
      lines.push(`${name}: ${value}`);
    }
    if (!hasLength && status !== 204 && status !== 304) {
      lines.push(`content-length: ${outBody.length}`);
    }
    lines.push(`connection: ${this.keepAlive ? 'keep-alive' : 'close'}`);
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'ascii');
    const packet = outBody.length === 0 ? head : Buffer.concat([head, outBody]);
    try {
      const drained = this.socket.write(packet);
      if (!drained) {
        // Small responses drain at once; if the kernel buffer is full,
        // wait before pumping the next request on this socket.
        this.socket.once('drain', () => this.onDone(this.keepAlive && !this.socket.destroyed));
        return;
      }
    } catch {
      this.onDone(false);
      return;
    }
    this.onDone(this.keepAlive && !this.socket.destroyed);
  }
}

// ---------------------------------------------------------------------------
// HTTP/1.x request parsing (incremental, from a growing buffer)
// ---------------------------------------------------------------------------

interface ParsedRequest {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  /** Bytes left over after this request (pipelined next request). */
  rest: Buffer;
  /** True when the client asked for 100-continue and we already sent it. */
  sentContinue: boolean;
}

function parseChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null {
  const parts: Buffer[] = [];
  let offset = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('ascii').split(';')[0].trim();
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BODY) throw new Error('bad chunk size');
    offset = lineEnd + 2;
    if (size === 0) {
      // Trailers run to the empty line.
      const trailerEnd = buf.indexOf('\r\n\r\n', offset);
      if (trailerEnd < 0) {
        // A lone CRLF ends the trailers with no trailer headers.
        if (buf.subarray(offset, offset + 2).toString('ascii') === '\r\n') return { body: Buffer.concat(parts), next: offset + 2 };
        return null;
      }
      return { body: Buffer.concat(parts), next: trailerEnd + 4 };
    }
    if (offset + size + 2 > buf.length) return null;
    parts.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
}

/**
 * Parse one request from the front of `buf`, or null when more bytes are
 * needed. Throws on a malformed request (the caller answers 400).
 * `sendContinue` is called when the head carries Expect: 100-continue.
 */
function tryParse(buf: Buffer, sendContinue: () => void): ParsedRequest | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > MAX_HEAD) throw new Error('request head too large');
    return null;
  }
  const headText = buf.subarray(0, headEnd).toString('ascii');
  const lines = headText.split('\r\n');
  const requestLine = lines[0] ?? '';
  const [method, target, version] = requestLine.split(' ');
  if (
    method === undefined ||
    target === undefined ||
    version === undefined ||
    !/^[A-Z]+$/.test(method) ||
    (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')
  ) {
    throw new Error('bad request line');
  }
  const headers: Record<string, string | string[]> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('bad header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  const bodyStart = headEnd + 4;
  const expect = headers['expect'];
  const wantsContinue = typeof expect === 'string' && expect.toLowerCase() === '100-continue';
  if (wantsContinue) sendContinue();
  const transferEncoding = headers['transfer-encoding'];
  const isChunked =
    (typeof transferEncoding === 'string' && transferEncoding.toLowerCase().includes('chunked')) ||
    (Array.isArray(transferEncoding) && transferEncoding.some((v) => v.toLowerCase().includes('chunked')));
  if (isChunked) {
    const parsed = parseChunked(buf, bodyStart);
    if (parsed === null) return null;
    if (parsed.body.length > MAX_BODY) throw new Error('request body too large');
    return { method, target, version, headers, body: parsed.body, rest: buf.subarray(parsed.next), sentContinue: wantsContinue };
  }
  const lengthRaw = headers['content-length'];
  const length = typeof lengthRaw === 'string' ? parseInt(lengthRaw, 10) : 0;
  if (!Number.isFinite(length) || length < 0) throw new Error('bad content-length');
  if (length > MAX_BODY) throw new Error('request body too large');
  if (buf.length < bodyStart + length) return null;
  return {
    method,
    target,
    version,
    headers,
    body: length === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(bodyStart, bodyStart + length)),
    rest: buf.subarray(bodyStart + length),
    sentContinue: wantsContinue,
  };
}

function keepAliveFor(version: string, headers: Record<string, string | string[]>): boolean {
  const connection = headers['connection'];
  const value = Array.isArray(connection) ? connection.join(', ') : (connection ?? '');
  const close = value.toLowerCase().includes('close');
  const keep = value.toLowerCase().includes('keep-alive');
  if (version === 'HTTP/1.1') return !close;
  return keep;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Build a TCP server that speaks HTTP/1.x and dispatches each request
 * through `dispatch` (app.ts's handler, same contract as node:http's
 * request listener). Returns a net.Server: listen/address/close behave
 * like the http.Server it replaces, so main.ts and dev-server.mjs need
 * no changes.
 */
export function createRawServer<Ctx>(
  dispatch: (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => Promise<void> | void,
  ctx: Ctx,
): net.Server {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let busy = false;
    let closed = false;

    const fail = (status: number): void => {
      closed = true;
      try {
        socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
      } catch {
        socket.destroy();
      }
    };

    const pump = (): void => {
      if (busy || closed || socket.destroyed) return;
      let parsed: ParsedRequest | null;
      try {
        parsed = tryParse(buf, () => {
          try {
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          } catch {
            // the socket is gone; parsing will fail below
          }
        });
      } catch {
        fail(400);
        return;
      }
      if (parsed === null) return;
      buf = parsed.rest;
      busy = true;
      const keepAlive = keepAliveFor(parsed.version, parsed.headers);
      const req = new RawRequest(socket, parsed.method, parsed.target, parsed.headers, parsed.body);
      const res = new RawResponse(socket, keepAlive, parsed.method === 'HEAD', (alive) => {
        busy = false;
        if (!alive || closed) {
          closed = true;
          try {
            socket.end();
          } catch {
            socket.destroy();
          }
          return;
        }
        pump();
      });
      try {
        const done = dispatch(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          ctx,
        );
        if (done !== undefined && typeof (done as Promise<void>).catch === 'function') {
          (done as Promise<void>).catch(() => {
            // dispatch answers 500 itself on handler errors; this only
            // fires if the 500 answer itself threw.
            try {
              socket.destroy();
            } catch {
              // already gone
            }
          });
        }
      } catch {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {
      closed = true;
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    });
    socket.on('close', () => {
      closed = true;
    });
  });
  return server;
}
