FROM node:20-alpine

WORKDIR /app

# Give the non-root "node" user ownership of the workdir so it can write
# node_modules during the install step below.
RUN chown node:node /app

# Run as the non-root "node" user that ships with the base image.
USER node

# Install the single runtime dependency (pg) before copying app sources so
# the npm layer is cached across source-only changes.
COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App sources.
COPY --chown=node:node server.js index.html dapps.json ./
# Static screenshot assets served at /screenshots/* by server.js.
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# Basic healthcheck (busybox provides wget on alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

