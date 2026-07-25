# Playwright base image ships a matching Chromium build + OS deps.
# Keep this tag in lockstep with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.55.1-noble

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
# Cloud Run injects PORT (defaults to 8080); config.ts reads it.
CMD ["node", "dist/server.js"]
