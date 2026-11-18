// Forge entrypoint: boots the app, registers with the harness env, and
// waits until the suite reports done. Implements the lifecycle described in
// README-starter.md using only node:http and the local app module.
import http from "node:http";
import { createApp } from "./app.ts";

const ENV_URL = process.env.MAKEFUN_ENV_URL;
if (!ENV_URL) {
  console.error("MAKEFUN_ENV_URL is not set; nothing to register with.");
  process.exit(1);
}

const BASE = ENV_URL.replace(/\/$/, "");

function jsonRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("error", reject);
    // Do not hang forever on a stalled env: abort the request after 10s
    // so the retry loop above can try again.
    req.setTimeout(10000, () => req.destroy(new Error("env request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function register(port: number): Promise<void> {
  let delay = 100;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const { status } = await jsonRequest("POST", "/register", { port });
      // 409 means this port is already registered (first register wins),
      // which is fine: the env already knows where to reach us.
      if (status === 200 || status === 201 || status === 409) {
        console.log(`registered on port ${port} (status ${status})`);
        return;
      }
      console.error(`register: unexpected status ${status}, retrying`);
    } catch (err) {
      console.error(`register: ${err}, retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
  throw new Error("register: gave up after retries");
}

async function waitDone(): Promise<void> {
  let delay = 200;
  for (;;) {
    try {
      const { status, text } = await jsonRequest("GET", "/done");
      if (status === 200) {
        const data = JSON.parse(text) as { done?: boolean };
        if (data.done) return;
      }
    } catch (err) {
      console.error(`done poll: ${err}, retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

const server = createApp();
server.listen(0, async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (!port) {
    console.error("could not determine bound port");
    process.exit(1);
  }
  try {
    await register(port);
    await waitDone();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  server.close(() => process.exit(0));
});
