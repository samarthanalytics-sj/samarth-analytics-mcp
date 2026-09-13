# Read-only runtime capture worker.
# Based on the official Playwright image which ships Chromium + all system deps.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install only what we need; playwright is already present in the base image,
# so the optional dependency resolves to the preinstalled package.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

COPY capture.mjs server.mjs cli.mjs ./

ENV PORT=8080
EXPOSE 8080

# Drop to the non-root user the Playwright image provides.
USER pwuser

CMD ["node", "server.mjs"]
