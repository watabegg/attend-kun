#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DEFAULT_PORT = 8789;

const args = parseArgs(process.argv.slice(2));
const clientId = args.clientId ?? process.env.GOOGLE_CLIENT_ID;
const clientSecret = args.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
const scope = args.scope ?? process.env.GMAIL_SCOPE ?? DEFAULT_SCOPE;
const port = Number.parseInt(args.port ?? process.env.OAUTH_PORT ?? String(DEFAULT_PORT), 10);

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.");
  console.error("Pass them as env vars or with --client-id and --client-secret.");
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("OAUTH_PORT must be an integer from 1024 to 65535.");
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const state = randomUUID();
const authUrl = buildAuthUrl({ clientId, redirectUri, scope, state });

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", redirectUri);
    if (requestUrl.pathname !== "/oauth2/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (requestUrl.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth state.");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(`OAuth failed: ${error}`);
      console.error(`OAuth failed: ${error}`);
      server.close();
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing authorization code.");
      return;
    }

    const token = await exchangeCodeForToken({
      clientId,
      clientSecret,
      redirectUri,
      code,
    });

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Token created</h1><p>You can close this tab and return to the terminal.</p>");

    printTokenResult(token);
    server.close();
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Failed to create token. Check the terminal.");
    console.error(error);
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OAuth callback server listening on ${redirectUri}`);
  console.log("");
  console.log("Open this URL and approve Gmail readonly access:");
  console.log(authUrl.toString());
  console.log("");
  openBrowser(authUrl.toString());
});

server.on("error", (error) => {
  console.error(`Failed to start callback server on port ${port}: ${error.message}`);
  process.exit(1);
});

function buildAuthUrl({ clientId, redirectUri, scope, state }) {
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  return authUrl;
}

async function exchangeCodeForToken({ clientId, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function printTokenResult(token) {
  console.log("");
  console.log("Refresh token created.");
  console.log("");

  if (!token.refresh_token) {
    console.log("No refresh_token was returned.");
    console.log("Re-run this script with the same account and keep prompt=consent, or revoke the app access in Google Account settings first.");
    console.log("");
  } else {
    console.log("GOOGLE_REFRESH_TOKEN:");
    console.log(token.refresh_token);
    console.log("");
    console.log("Set it in Cloudflare Workers:");
    console.log(`printf '%s' '${escapeSingleQuoted(token.refresh_token)}' | npx wrangler secret put GOOGLE_REFRESH_TOKEN`);
    console.log("");
  }

  if (token.scope) {
    console.log(`Granted scope: ${token.scope}`);
  }
}

function openBrowser(url) {
  if (process.env.NO_BROWSER === "1") {
    return;
  }

  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }

    if (key === "client-id") {
      parsed.clientId = value;
    } else if (key === "client-secret") {
      parsed.clientSecret = value;
    } else if (key === "scope") {
      parsed.scope = value;
    } else if (key === "port") {
      parsed.port = value;
    }
  }

  return parsed;
}

function escapeSingleQuoted(value) {
  return value.replace(/'/g, "'\\''");
}

function printHelp() {
  console.log(`Usage:
  npm run gmail:token -- --client-id <id> --client-secret <secret>

Options:
  --client-id       Google OAuth client ID. Env: GOOGLE_CLIENT_ID
  --client-secret   Google OAuth client secret. Env: GOOGLE_CLIENT_SECRET
  --scope           OAuth scope. Env: GMAIL_SCOPE
  --port            Local callback port. Env: OAUTH_PORT

Defaults:
  scope: ${DEFAULT_SCOPE}
  port:  ${DEFAULT_PORT}
`);
}
