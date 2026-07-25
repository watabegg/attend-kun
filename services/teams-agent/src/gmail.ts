/**
 * Minimal Gmail reader used only to fetch the Microsoft account verification
 * code during an interactive Teams login. Reuses the same OAuth refresh-token
 * flow as the Cloudflare Worker's gmail module, trimmed to what we need here.
 */

export type GmailCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type VerificationCode = {
  code: string;
  messageId: string;
  internalDate: number;
};

type TokenResponse = { access_token?: string; error?: string; error_description?: string };

type ListResponse = { messages?: Array<{ id?: string }> };

type GmailApiMessage = {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

export async function fetchAccessToken(credentials: GmailCredentials): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description ?? payload.error ?? response.statusText;
    throw new Error(`failed to refresh Google access token: ${detail}`);
  }
  return payload.access_token;
}

/**
 * Poll Gmail for the most recent Microsoft verification-code email that arrived
 * after `notBefore`. Resolves with the parsed code, or throws on timeout.
 */
export async function waitForVerificationCode(options: {
  credentials: GmailCredentials;
  userId: string;
  fromAddress: string;
  notBefore: number;
  timeoutSeconds: number;
  pollIntervalMs: number;
  log?: (message: string) => void;
}): Promise<VerificationCode> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const log = options.log ?? (() => {});
  // Query recent mail from the Microsoft sender; internalDate filtering below
  // guarantees we never accept a code from before this login attempt.
  const query = `from:${options.fromAddress} newer_than:1h`;

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const accessToken = await fetchAccessToken(options.credentials);
    const found = await findLatestCode(accessToken, options.userId, query, options.notBefore);
    if (found) {
      log(`verification code found on attempt ${attempt}`);
      return found;
    }
    log(`no verification code yet (attempt ${attempt}), retrying...`);
    await sleep(options.pollIntervalMs);
  }

  throw new Error(
    `timed out after ${options.timeoutSeconds}s waiting for verification code from ${options.fromAddress}`,
  );
}

async function findLatestCode(
  accessToken: string,
  userId: string,
  query: string,
  notBefore: number,
): Promise<VerificationCode | null> {
  const ids = await listMessageIds(accessToken, userId, query);
  const candidates: VerificationCode[] = [];

  for (const id of ids) {
    const message = await getMessage(accessToken, userId, id);
    const internalDate = message.internalDate ? Number.parseInt(message.internalDate, 10) : 0;
    // Allow a small negative skew so a code sent moments before we recorded the
    // start time is still accepted.
    if (internalDate < notBefore - 60_000) {
      continue;
    }
    const text = `${message.snippet ?? ""}\n${extractText(message.payload)}`;
    const code = parseCode(text);
    if (code) {
      candidates.push({ code, messageId: id, internalDate });
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.internalDate - a.internalDate);
  return candidates[0] ?? null;
}

async function listMessageIds(accessToken: string, userId: string, query: string): Promise<string[]> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages`,
  );
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("fields", "messages/id");

  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    throw new Error(`failed to list Gmail messages: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as ListResponse;
  return (payload.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));
}

async function getMessage(accessToken: string, userId: string, messageId: string): Promise<GmailApiMessage> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set("format", "full");

  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    throw new Error(`failed to get Gmail message ${messageId}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GmailApiMessage;
}

/**
 * The verification email renders the code on its own line right after
 * "Account verification code:". We prefer that anchored match and fall back to
 * any standalone 6-8 digit run.
 */
export function parseCode(text: string): string | null {
  const anchored = text.match(/verification code:?\s*([0-9]{6,8})/i);
  if (anchored && anchored[1]) {
    return anchored[1];
  }
  const loose = text.match(/\b([0-9]{6,8})\b/);
  return loose && loose[1] ? loose[1] : null;
}

function extractText(payload?: GmailPart): string {
  if (!payload) {
    return "";
  }
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === "text/plain" || payload.mimeType === "text/html") {
      return decoded;
    }
  }
  let out = "";
  for (const part of payload.parts ?? []) {
    out += `\n${extractText(part)}`;
  }
  return out;
}

export function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
