/**
 * HTTP surface for the teams-agent Cloud Run service.
 *
 * Endpoints (all except /health require `Authorization: Bearer <shared secret>`):
 *   GET  /health  -> liveness probe
 *   POST /login   -> force a fresh Teams login (email + MFA)
 *   POST /send     { "text": "開始します" } -> send a message to the target chat
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

import { loadConfig } from "./config";
import { TeamsAgent } from "./teams-agent";

const config = loadConfig();
const agent = new TeamsAgent(config);
const app = express();
app.use(express.json());

function log(requestId: string): (message: string) => void {
  return (message: string) => console.log(`[${requestId}] ${message}`);
}

let counter = 0;
function nextRequestId(): string {
  counter += 1;
  return `req-${counter}`;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix) || !secureEqual(header.slice(prefix.length), config.sharedSecret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function secureEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/login", requireAuth, async (_req, res) => {
  const requestId = nextRequestId();
  try {
    const result = await agent.login(log(requestId));
    res.json(result);
  } catch (error) {
    console.error(`[${requestId}] login failed`, error);
    res.status(502).json({ error: (error as Error).message });
  }
});

app.post("/send", requireAuth, async (req, res) => {
  const requestId = nextRequestId();
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const result = await agent.send(text, log(requestId));
    res.json(result);
  } catch (error) {
    console.error(`[${requestId}] send failed`, error);
    res.status(502).json({ error: (error as Error).message });
  }
});

app.listen(config.port, () => {
  console.log(`teams-agent listening on port ${config.port}`);
});
