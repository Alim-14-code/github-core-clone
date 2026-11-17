// The forge's HTTP server: routing, auth and the JSON 404. The surfaces live in
// src/git.ts (git smart HTTP), src/rest.ts (REST v3), src/graphql.ts (GraphQL v4)
// and src/mcp.ts (MCP); each owns its routes and returns false when a request is
// not its own, so this file only dispatches and answers the fall-through.
//
// Auth: the suite presents Authorization: Bearer $MAKEFUN_SHOP_TOKEN on every API
// call (REST, GraphQL, MCP). /healthz takes none. Git smart HTTP takes none
// (the suite's in-process git client sends no bearer token). When
// MAKEFUN_SHOP_TOKEN is unset (local runs) any non-empty bearer token is
// accepted, so the local runner can use any --token; in a trial the variable
// is always set and the check is exact.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Ctx, type Store } from './src/store.ts';
import { nextRequestId, pathOf, sendError, sendJson } from './src/util.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const ctx: Ctx = { store: createStore(), requestSeq: { value: 0 } };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, ctx)) return;
        } else if (path === '/api/graphql') {
          if (await handleGraphql(req, res, ctx)) return;
        } else if (path === '/mcp') {
          if (await handleMcp(req, res, ctx)) return;
        } else if (GIT_PATH.test(path)) {
          if (await handleGit(req, res, ctx)) return;
        }

        // Everything else, every method: GitHub's 404 body (JSON, never HTML).
        sendError(res, 404, 'Not Found', { 'x-github-request-id': nextRequestId(ctx.requestSeq) });
      } catch (err) {
        // Never let a handler crash the connection: answer 500 JSON and keep serving.
        try {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error', {
            'x-github-request-id': nextRequestId(ctx.requestSeq),
          });
        } catch {
          try {
            res.destroy();
          } catch {
            // nothing left to do
          }
        }
      }
    })();
  });
}
