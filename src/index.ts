import { isPunchType, messageForPunch } from "./messages";
import { sendToTeams } from "./teams-client";
import { renderUi } from "./ui";

export interface Env {
  /** Passcode required by the UI and /api/punch (Bearer). */
  APP_AUTH_TOKEN?: string;
  /** Base URL of the Cloud Run teams-agent service. */
  TEAMS_AGENT_URL: string;
  /** Shared secret sent to the teams-agent. */
  AGENT_SHARED_SECRET: string;
  /** Human-readable target chat name, shown in the UI. */
  TARGET_CHAT_NAME?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return html(renderUi({ targetChatName: env.TARGET_CHAT_NAME ?? "Configured Teams chat" }));
    }

    if (url.pathname === "/api/punch" && request.method === "POST") {
      return handlePunch(request, env);
    }

    return json({ error: "not found" }, 404);
  },
};

async function handlePunch(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { type?: unknown };
  try {
    body = (await request.json()) as { type?: unknown };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!isPunchType(body.type)) {
    return json({ error: "type must be one of start|end|break|resume" }, 400);
  }

  const text = messageForPunch(body.type);
  try {
    const result = await sendToTeams(env, text);
    return json({ type: body.type, ...result });
  } catch (error) {
    return json({ error: (error as Error).message }, 502);
  }
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.APP_AUTH_TOKEN) {
    return false;
  }
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return false;
  }
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(authorization.slice(prefix.length))),
    crypto.subtle.digest("SHA-256", encoder.encode(env.APP_AUTH_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
