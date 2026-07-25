/**
 * Google OAuth helper (refresh-token → access-token exchange).
 *
 * Kept for Phase 3, where the Worker reads Google Calendar to produce the
 * weekly attendance schedule. The Gmail MFA reading path lives in the Cloud Run
 * teams-agent instead, so this module is intentionally generic over scope.
 */

export type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type TokenResponse = { access_token?: string; error?: string; error_description?: string };

export async function fetchAccessToken(
  credentials: GoogleCredentials,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetcher("https://oauth2.googleapis.com/token", {
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
