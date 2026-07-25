/**
 * Microsoft Graph helpers: extract a delegated access token from an
 * authenticated Teams page, and send a chat message with it.
 *
 * We do NOT register our own Entra application (guest account, no admin). The
 * only way to obtain a Graph token for this account is to let the first-party
 * Teams web client acquire it via MSAL, then reuse the token the client cached
 * or sent on the wire. This is inherently coupled to Teams internals, but the
 * verification report confirmed a cached token with the ChatMessage.Send scope
 * exists in the session.
 */

import type { Page } from "playwright";

const GRAPH_AUDIENCES = ["https://graph.microsoft.com", "https://graph.microsoft.com/"];
const REQUIRED_SCOPE = "chatmessage.send";
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

type JwtPayload = {
  aud?: string;
  scp?: string;
  exp?: number;
  tid?: string;
};

export type GraphToken = {
  jwt: string;
  scopes: string[];
  tenantId?: string;
  expiresAt: number;
};

/** Collects bearer tokens seen on outgoing Graph requests while the page loads. */
export class GraphTokenCollector {
  private readonly seen = new Set<string>();

  constructor(page: Page) {
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("https://graph.microsoft.com")) {
        return;
      }
      const auth = request.headers()["authorization"];
      if (auth && auth.toLowerCase().startsWith("bearer ")) {
        this.seen.add(auth.slice(7).trim());
      }
    });
  }

  tokens(): string[] {
    return [...this.seen];
  }
}

/**
 * Best delegated Graph token with ChatMessage.Send, drawn from (a) tokens seen
 * on the wire and (b) any JWT sitting in local/session storage (MSAL cache).
 * Returns the one with the latest expiry, or null if none qualifies.
 */
export async function extractGraphToken(
  page: Page,
  collector: GraphTokenCollector,
  log?: (message: string) => void,
): Promise<GraphToken | null> {
  const fromStorage = await readStorageStrings(page);
  const candidates = new Set<string>(collector.tokens());
  for (const value of fromStorage) {
    const matches = value.match(JWT_PATTERN);
    for (const match of matches ?? []) {
      candidates.add(match);
    }
  }

  const now = Date.now();
  const valid: GraphToken[] = [];
  const graphAudScopes: string[] = [];
  for (const jwt of candidates) {
    const payload = decodeJwt(jwt);
    if (!payload) {
      continue;
    }
    const aud = payload.aud ?? "";
    if (!GRAPH_AUDIENCES.includes(aud)) {
      continue;
    }
    const scopes = (payload.scp ?? "").split(" ").filter(Boolean);
    graphAudScopes.push(scopes.join("|") || "(no scp)");
    if (!scopes.some((scope) => scope.toLowerCase() === REQUIRED_SCOPE)) {
      continue;
    }
    const expiresAt = (payload.exp ?? 0) * 1000;
    if (expiresAt <= now + 60_000) {
      continue;
    }
    valid.push({ jwt, scopes, expiresAt, ...(payload.tid ? { tenantId: payload.tid } : {}) });
  }

  if (log) {
    log(
      `token scan: storageStrings=${fromStorage.length} candidateJwts=${candidates.size} ` +
        `graphAudTokens=${graphAudScopes.length} withRequiredScope=${valid.length}` +
        (graphAudScopes.length ? ` | graph scopes seen: ${graphAudScopes.join(" ;; ")}` : ""),
    );
  }

  if (valid.length === 0) {
    return null;
  }
  valid.sort((a, b) => b.expiresAt - a.expiresAt);
  return valid[0] ?? null;
}

async function readStorageStrings(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(async () => {
      const out: string[] = [];
      const scan = (store: Storage) => {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (!key) {
            continue;
          }
          const value = store.getItem(key);
          if (value) {
            out.push(value);
          }
        }
      };
      try {
        scan(window.localStorage);
      } catch {
        /* storage may be inaccessible */
      }
      try {
        scan(window.sessionStorage);
      } catch {
        /* storage may be inaccessible */
      }

      // New Teams (teams.cloud.microsoft) keeps the MSAL token cache in
      // IndexedDB, so scan every database's object stores too.
      try {
        const databases = (await indexedDB.databases?.()) ?? [];
        for (const info of databases) {
          const name = info.name;
          if (!name) {
            continue;
          }
          await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };
            const openReq = indexedDB.open(name);
            openReq.onerror = done;
            openReq.onblocked = done;
            openReq.onsuccess = () => {
              const db = openReq.result;
              const stores = Array.from(db.objectStoreNames);
              if (stores.length === 0) {
                db.close();
                done();
                return;
              }
              let pending = stores.length;
              const finishStore = () => {
                pending -= 1;
                if (pending === 0) {
                  db.close();
                  done();
                }
              };
              try {
                const tx = db.transaction(stores, "readonly");
                for (const storeName of stores) {
                  const getAll = tx.objectStore(storeName).getAll();
                  getAll.onsuccess = () => {
                    for (const value of getAll.result) {
                      try {
                        out.push(typeof value === "string" ? value : JSON.stringify(value));
                      } catch {
                        /* unserialisable */
                      }
                    }
                    finishStore();
                  };
                  getAll.onerror = finishStore;
                }
              } catch {
                db.close();
                done();
              }
            };
            // Safety timeout so a stuck DB never hangs the scan.
            setTimeout(done, 4000);
          });
        }
      } catch {
        /* IndexedDB may be unavailable */
      }

      return out;
    });
  } catch {
    return [];
  }
}

function decodeJwt(jwt: string): JwtPayload | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

/** Sends a plain-text message to a chat via Microsoft Graph. */
export async function sendChatMessage(
  accessToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: { contentType: "text", content: text } }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`failed to send Teams message: ${response.status} ${detail}`);
  }
}
