# Web Audit MCP — HTTP transport, headless-Chromium audit agent.
# Based on the official Playwright image which ships Chromium + all system deps.
#
# Build context MUST be the repo root (this server compiles in the shared
# consent engine from apps/portal/shared):
#   docker build -f apps/web-audit-mcp/Dockerfile -t samarth-web-audit-mcp .
#   docker run -p 8080:8080 -e WEB_AUDIT_HTTP_AUTH_TOKEN=... -e WEB_AUDIT_ALLOWLIST=client.com samarth-web-audit-mcp
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app/apps/web-audit-mcp

# Install deps first for layer caching. Playwright is already in the base image,
# so the optional dependency resolves to the preinstalled browser.
COPY apps/web-audit-mcp/package.json apps/web-audit-mcp/package-lock.json apps/web-audit-mcp/tsconfig.json ./
RUN npm install --no-audit --no-fund

# The server's only cross-app import is the shared consent engine. tsc (rootDir
# "..") emits it to dist/portal/shared/, matching the runtime import path.
COPY apps/web-audit-mcp/src ./src
COPY apps/portal/shared/consent-audit.ts /app/apps/portal/shared/consent-audit.ts

# Compile, then drop devDeps (tsc/tsx/types) from the runtime image.
RUN npm run build && npm prune --omit=dev

ENV WEB_AUDIT_TRANSPORT=http
ENV PORT=8080
EXPOSE 8080

# Drop to the non-root user the Playwright image provides.
USER pwuser

CMD ["node", "dist/web-audit-mcp/src/index.js"]
