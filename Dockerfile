# Samarth GTM MCP server — stdio transport by default.
#
# Build:  docker build -t samarth-gtm-mcp .
# Run:    docker run -i --rm \
#           -e GOOGLE_OAUTH_CLIENT_ID=... \
#           -e GOOGLE_OAUTH_CLIENT_SECRET=... \
#           -e GOOGLE_REFRESH_TOKEN=... \
#           samarth-gtm-mcp
#
# For the Streamable HTTP transport instead:
#   docker run --rm -p 3001:3001 -e GTM_MCP_TRANSPORT=http samarth-gtm-mcp
#
# The server starts without credentials (tools respond with auth guidance),
# so introspection (initialize / tools/list) works on a bare container.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
