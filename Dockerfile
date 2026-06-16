FROM node:20-alpine

WORKDIR /app

# Give the non-root "node" user ownership of the workdir so it can write
# node_modules during the install step below.
RUN chown node:node /app

# Run as the non-root "node" user that ships with the base image.
USER node

# Install the single runtime dependency (pg, for the micro-blog feed and pins)
# before copying app sources so the npm layer is cached across source-only changes.
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App sources.
COPY --chown=node:node server.js index.html dapps.json ./
# Static screenshot assets served at /screenshots/* by server.js.
COPY public ./public

# Drop privileges for runtime.
USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

# Drop to non-root user at runtime only (after build steps complete as root).
USER node
CMD ["node", "server.js"]
