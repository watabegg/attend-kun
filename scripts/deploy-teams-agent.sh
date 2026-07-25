#!/usr/bin/env bash
#
# Deploy the teams-agent service to Cloud Run.
#
# Requires the three Google OAuth values (for reading the MFA code from Gmail)
# in the environment:
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
#
# Usage:
#   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
#     scripts/deploy-teams-agent.sh
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to the target Google Cloud project ID}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-teams-agent}"
SA_EMAIL="${SA_EMAIL:-teams-agent@${PROJECT_ID}.iam.gserviceaccount.com}"
SOURCE_DIR="$(cd "$(dirname "$0")/../services/teams-agent" && pwd)"

# Stable, non-secret configuration.
GCS_BUCKET="${GCS_BUCKET:-${PROJECT_ID}-sessions}"
TEAMS_LOGIN_EMAIL="${TEAMS_LOGIN_EMAIL:?Set TEAMS_LOGIN_EMAIL to the Microsoft login email}"
TARGET_CHAT_ID="${TARGET_CHAT_ID:?Set TARGET_CHAT_ID to the destination Teams chat ID}"
TEAMS_LOGIN_URL="${TEAMS_LOGIN_URL:-https://teams.microsoft.com/}"
MFA_FROM="${MFA_FROM:-account-security-noreply@accountprotection.microsoft.com}"

for var in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: environment variable $var is required" >&2
    exit 1
  fi
done

echo "==> Upserting Google OAuth secrets in Secret Manager"
upsert_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=-
  else
    printf '%s' "$value" | gcloud secrets create "$name" --project="$PROJECT_ID" \
      --data-file=- --replication-policy=automatic
  fi
}
upsert_secret google-client-id "$GOOGLE_CLIENT_ID"
upsert_secret google-client-secret "$GOOGLE_CLIENT_SECRET"
upsert_secret google-refresh-token "$GOOGLE_REFRESH_TOKEN"

echo "==> Deploying $SERVICE to Cloud Run (from source, this builds via Cloud Build)"
gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source="$SOURCE_DIR" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --max-instances=1 \
  --concurrency=1 \
  --cpu=2 \
  --memory=2Gi \
  --timeout=300 \
  --set-env-vars="GCS_BUCKET=${GCS_BUCKET},TEAMS_LOGIN_EMAIL=${TEAMS_LOGIN_EMAIL},TARGET_CHAT_ID=${TARGET_CHAT_ID},TEAMS_LOGIN_URL=${TEAMS_LOGIN_URL},MFA_FROM=${MFA_FROM},GMAIL_USER_ID=me" \
  --set-secrets="AGENT_SHARED_SECRET=agent-shared-secret:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,GOOGLE_REFRESH_TOKEN=google-refresh-token:latest"

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
echo ""
echo "==> Deployed: $URL"
echo "Set this as the Worker's TEAMS_AGENT_URL in wrangler.jsonc."
