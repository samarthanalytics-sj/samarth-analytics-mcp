# Read-only runtime capture worker.
# Based on the official Playwright image which ships Chromium + all system deps.
#
# The image only ships the browser builds for ONE Playwright version (under
# /ms-playwright), and nothing here runs `playwright install`. So the tag below
# MUST equal the exact "playwright" version pinned in package.json, or every
# chromium.launch() fails with "Executable doesn't exist". Bump both together
# (url-guard.test.mjs fails the build if they drift).
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install only what we need. npm installs the exact playwright version pinned in
# package.json; its browsers come from the base image above.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

# Every runtime module, including everything server.mjs / capture.mjs import
# (url-guard.mjs). A missing one is ERR_MODULE_NOT_FOUND at boot.
COPY capture.mjs server.mjs cli.mjs queue-consumer.mjs url-guard.mjs ./

ENV PORT=8080
EXPOSE 8080

# Drop to the non-root user the Playwright image provides.
USER pwuser

CMD ["node", "server.mjs"]
