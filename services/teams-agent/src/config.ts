/**
 * Runtime configuration for the teams-agent Cloud Run service.
 *
 * Secrets (shared secret, Google OAuth) come from environment variables that
 * are wired up as Cloud Run secrets. Stable identifiers (tenant, chat, email)
 * are plain environment variables so they can be changed without a redeploy of
 * the calling Worker.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export type Config = {
  port: number;
  sharedSecret: string;

  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    userId: string;
  };

  gcs: {
    bucket: string;
    sessionObject: string;
    debugPrefix: string;
  };

  teams: {
    loginUrl: string;
    loginEmail: string;
    targetChatId: string;
  };

  mfa: {
    fromAddress: string;
    /** Max seconds to wait for the verification code email. */
    timeoutSeconds: number;
    /** Poll interval in milliseconds. */
    pollIntervalMs: number;
  };

  /** Upload a screenshot + HTML to GCS whenever the login flow fails. */
  debugArtifacts: boolean;
};

export function loadConfig(): Config {
  return {
    port: Number.parseInt(optional("PORT", "8080"), 10),
    sharedSecret: required("AGENT_SHARED_SECRET"),

    google: {
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      refreshToken: required("GOOGLE_REFRESH_TOKEN"),
      userId: optional("GMAIL_USER_ID", "me"),
    },

    gcs: {
      bucket: required("GCS_BUCKET"),
      sessionObject: optional("SESSION_OBJECT", "session/storageState.json"),
      debugPrefix: optional("DEBUG_PREFIX", "debug"),
    },

    teams: {
      loginUrl: optional("TEAMS_LOGIN_URL", "https://teams.microsoft.com/"),
      loginEmail: required("TEAMS_LOGIN_EMAIL"),
      targetChatId: required("TARGET_CHAT_ID"),
    },

    mfa: {
      fromAddress: optional(
        "MFA_FROM",
        "account-security-noreply@accountprotection.microsoft.com",
      ),
      timeoutSeconds: Number.parseInt(optional("MFA_TIMEOUT_SECONDS", "120"), 10),
      pollIntervalMs: Number.parseInt(optional("MFA_POLL_INTERVAL_MS", "3000"), 10),
    },

    debugArtifacts: optional("DEBUG_ARTIFACTS", "false") === "true",
  };
}
