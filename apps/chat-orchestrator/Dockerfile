# Chat orchestrator: the GTM/GA4 AI chat backend for aitagmanager.com.
#
# The image bundles BOTH the orchestrator and the MCP server, because the
# orchestrator spawns the MCP as a child process, one per signed-in user, each
# holding only that user's Google access token.
#
# Build from the REPO ROOT, not this directory:
#   docker build -f apps/chat-orchestrator/Dockerfile -t samarth-chat-orchestrator .
#
# Run:
#   docker run --rm -p 8787:8787 --env-file .env samarth-chat-orchestrator
#
# Sizing: each live MCP child is roughly 150-300 MB. Budget
# 512 MB + (MCP_POOL_MAX_SESSIONS x 300 MB) and set the pool cap to match the
# memory you actually gave the container, or the OOM killer will do it for you.

# ── Stage 1: build the MCP server (TypeScript → dist/) ──────────────────────
FROM node:20-alpine AS mcp-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: build the orchestrator ─────────────────────────────────────────
FROM node:20-alpine AS orchestrator-build
WORKDIR /app/apps/chat-orchestrator
COPY apps/chat-orchestrator/package.json apps/chat-orchestrator/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/chat-orchestrator/tsconfig.json ./
COPY apps/chat-orchestrator/src ./src
# The system prompt imports the shared GTM methodology from the desktop app, so
# the compiler needs that one file. tsconfig lists it explicitly.
COPY apps/desktop/src/shared/gtm-methodology.ts /app/apps/desktop/src/shared/gtm-methodology.ts
RUN npm run build

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# MCP server runtime deps (googleapis, the MCP SDK) at the image root, which is
# where the spawned child resolves its imports from.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=mcp-build /app/dist ./dist

# Orchestrator runtime deps and build output.
WORKDIR /app/apps/chat-orchestrator
COPY apps/chat-orchestrator/package.json apps/chat-orchestrator/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=orchestrator-build /app/apps/chat-orchestrator/dist ./dist

# The orchestrator spawns `node /app/dist/index.js` as the MCP child. Absolute,
# so it does not depend on the working directory at runtime.
ENV MCP_ARGS=/app/dist/index.js
ENV MCP_TRANSPORT=stdio
ENV PORT=8787
# Bind all interfaces: inside a container, 127.0.0.1 would be unreachable from
# the reverse proxy. The container itself must NOT be published directly; nginx
# is the only thing that should reach this port.
ENV ORCHESTRATOR_HOST=0.0.0.0

# Never run as root. `node` is provided by the base image.
RUN chown -R node:node /app
USER node

EXPOSE 8787

# /health reports MCP tool count and pool state, so a failure here means the
# MCP link is broken, not just that the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/chat-orchestrator/src/index.js"]
