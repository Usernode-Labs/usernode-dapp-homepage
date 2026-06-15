FROM node:20-alpine

WORKDIR /app

# Install the single runtime dependency (pg, for the micro-blog feed's Postgres
# store). Done as root so node_modules is writable, then we drop to the non-root
# "node" user for runtime. The homepage itself is still stdlib-only; pg is loaded
# lazily and only used when DATABASE_URL is set.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Application files.
COPY server.js index.html dapps.json ./
# Static screenshot assets served at /screenshots/* by server.js.
COPY public ./public

# Drop privileges for runtime.
USER node

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# Basic healthcheck (busybox provides wget on alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
