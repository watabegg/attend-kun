# teams-agent (Cloud Run)

Headless Teams login + Microsoft Graph message sender. Called by the Cloudflare
Worker to post attendance messages ("開始します" etc.) to a Teams chat.

Because this account is an external guest with no Entra app registration, the
only way to get a Graph token is to let the first-party Teams web client acquire
it via MSAL. This service drives that login with Playwright, reuses the cached
token, and sends via `POST /chats/{chatId}/messages`.

## How it works

1. Restore the saved browser session (`storageState`) from GCS.
2. Open Teams. If the session is still valid, no MFA is needed.
3. If expired, log in: enter email → Microsoft emails a code → read it from
   Gmail → submit → "Stay signed in? Yes" → persist the new session to GCS.
4. Extract a Graph access token (with `ChatMessage.Send`) from the page and send
   the message.

## Endpoints

- `GET /health` — liveness.
- `POST /login` — force a fresh login. Requires `Authorization: Bearer <secret>`.
- `POST /send` `{ "text": "開始します" }` — send to the configured chat.

## Environment

Required: `AGENT_SHARED_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN`, `GCS_BUCKET`, `TEAMS_LOGIN_EMAIL`, `TARGET_CHAT_ID`.

Optional: `TEAMS_LOGIN_URL`, `MFA_FROM`, `SESSION_OBJECT`, `GMAIL_USER_ID`,
`MFA_TIMEOUT_SECONDS`, `MFA_POLL_INTERVAL_MS`, `DEBUG_ARTIFACTS`, `DEBUG_PREFIX`.

`DEBUG_ARTIFACTS` defaults to `false`. Enable it only for short-lived diagnosis:
screenshots and HTML captured from a login flow can contain account or session
information and must stay in a private bucket with a short retention policy.

## Local build check

```sh
npm install
npm run check
```
