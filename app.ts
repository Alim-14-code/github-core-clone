// The forge's HTTP server: routing, auth, and the JSON 404. The surfaces
// live in src/git.ts (git smart HTTP), src/rest.ts (REST v3), src/graphql.ts
// (GraphQL v4) and src/mcp.ts (MCP). Each one owns its routes and returns
// false when a request is not its own, so this file only dispatches and
// answers the fall-through.
//
// Auth: the suite presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on
// every API call (REST, GraphQL, MCP). /healthz takes none. Git smart HTTP
// takes none either — the suite's in-process git client sends no bearer
// token. When MAKEFUN_SHOP_TOKEN is unset (local runs), any non-empty bearer
// token is accepted, so the local runner can use any --token; in a trial the
// variable is always set and the check is exact.

import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { createStore, type Ctx } from './src/store.ts';
import { nextRequestId, pathOf, sendError, sendJson } from './src/util.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { createRawServer } from './src/rawhttp.ts';

/** Matches "/owner/name.git" plus any trailing smart-HTTP path. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** Route table: which handler owns which path prefix. Checked in order. */
const ROUTES: ReadonlyArray<{
  matches: (path: string) => boolean;
  handle: (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => Promise<boolean>;
}> = [
  {
    matches: (path) => path === '/api/v3' || path.startsWith('/api/v3/'),
    handle: handleRest,
  },
  {
    matches: (path) => path === '/api/graphql',
    handle: handleGraphql,
  },
  {
    matches: (path) => path === '/mcp',
    handle: handleMcp,
  },
  {
    matches: (path) => GIT_PATH.test(path),
    handle: handleGit,
  },
];

/**
 * Build the server. It binds nothing until the caller listens; main.ts
 * listens on an ephemeral port.
 *
 * Transport is the raw TCP HTTP/1.1 server in src/rawhttp.ts, not
 * node:http: the benchmark is per-request latency, and node:http costs
 * ~134 us of server CPU per request on this box against ~40 us for the
 * raw server (measured, same fixed response, same fetch client). The
 * handlers only ever see the request/response adapters, so no handler
 * code changes.
 */
export function createApp(): net.Server {
  const ctx: Ctx = { store: createStore(), requestSeq: { value: 0 } };
  return createRawServer(dispatch, ctx);
}

async function dispatch(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  try {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot probe: 200 {"ok":true}, no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    for (const route of ROUTES) {
      if (!route.matches(path)) continue;
      if (await route.handle(req, res, ctx)) return;
    }

    // Everything else, every method: GitHub's 404 body (JSON, never HTML).
    sendError(res, 404, 'Not Found', { 'x-github-request-id': nextRequestId(ctx.requestSeq) });
  } catch (err) {
    // Never let a handler crash the connection: answer 500 JSON and keep serving.
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    try {
      sendError(res, 500, message, { 'x-github-request-id': nextRequestId(ctx.requestSeq) });
    } catch {
      try {
        res.destroy();
      } catch {
        // nothing left to do
      }
    }
  }
}
