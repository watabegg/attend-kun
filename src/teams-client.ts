/** Thin client for the Cloud Run teams-agent service. */

export type TeamsAgentEnv = {
  TEAMS_AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
};

export type SendResult = {
  ok: true;
  text: string;
  tokenExpiresAt?: number;
  tenantId?: string;
  relogin?: boolean;
};

/** Posts `text` to the configured Teams chat via the Cloud Run agent. */
export async function sendToTeams(env: TeamsAgentEnv, text: string): Promise<SendResult> {
  if (!env.TEAMS_AGENT_URL || !env.AGENT_SHARED_SECRET) {
    throw new Error("TEAMS_AGENT_URL and AGENT_SHARED_SECRET must be configured");
  }

  const response = await fetch(`${env.TEAMS_AGENT_URL.replace(/\/$/, "")}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AGENT_SHARED_SECRET}`,
    },
    body: JSON.stringify({ text }),
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<SendResult> & {
    error?: string;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `teams-agent send failed: ${response.status}`);
  }

  return payload as SendResult;
}
