FROM node:20-alpine

WORKDIR /app

# Copy package files first so dependencies are cached independently of app code.
COPY package*.json ./

# Install dependencies as the default user first (needed for npm).
RUN npm ci --only=production

# Run as the non-root "node" user that ships with the base image.
USER node

# Copy app code and static files.
COPY --chown=node:node server.js index.html nft-terminal.html dapps.json ./
COPY --chown=node:node dapp.json ./
# Static screenshot assets served at /screenshots/* by server.js.
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Basic healthcheck (busybox provides wget on alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

