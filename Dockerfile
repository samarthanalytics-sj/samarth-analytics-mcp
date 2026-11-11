# Samarth GTM MCP server — stdio transport by default.
#
# Build:  docker build -t samarth-gtm-mcp .
# Run:    docker run -i --rm \
#           -e GOOGLE_OAUTH_CLIENT_ID=... \
#           -e GOOGLE_OAUTH_CLIENT_SECRET=... \
#           -e GOOGLE_REFRESH_TOKEN=... \
#           samarth-gtm-mcp
#
# For the Streamable HTTP transport instead. It refuses to start without an
# auth mode, so pass a bearer token (or the STYTCH_* variables):
#   docker run --rm -p 3001:3001 -e GTM_MCP_TRANSPORT=http \
#     -e GTM_MCP_HTTP_AUTH_TOKEN=<a strong secret> samarth-gtm-mcp
#
# The server starts without Google credentials (tools respond with auth
# guidance), so introspection (initialize / tools/list) works on a bare
# container.

# ── Stage 1: build the MCP server (TypeScript → dist/) ──────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: build the authorize React app (Stytch login + consent) ─────────
FROM node:22-alpine AS authorize-build
WORKDIR /app/authorize
COPY apps/mcp-authorize/package.json apps/mcp-authorize/package-lock.json ./
# npm ci: install exactly the committed lockfile. `npm install` re-resolved on
# every build and broke the moment a transitive peer range moved.
RUN npm ci --no-audit --no-fund
COPY apps/mcp-authorize/ ./
RUN npm run build

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Where the server serves the authorize UI from (see src/index.ts).
ENV AUTHORIZE_UI_DIR=/app/authorize-ui
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=authorize-build /app/authorize/dist ./authorize-ui
CMD ["node", "dist/index.js"]
