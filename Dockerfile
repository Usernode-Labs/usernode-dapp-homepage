FROM node:20-alpine

WORKDIR /app

# Install dependencies as root so npm can write node_modules/ to /app.
COPY poker/package.json ./
RUN npm install --omit=dev

COPY poker/server.js ./
COPY poker/db ./db
COPY poker/engine ./engine
COPY poker/chain ./chain
COPY poker/view.js ./
COPY poker/public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

# Drop to non-root user at runtime only (after build steps complete as root).
USER node
CMD ["node", "server.js"]
