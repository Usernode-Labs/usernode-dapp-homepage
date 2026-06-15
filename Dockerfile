FROM node:20-alpine

WORKDIR /app

# Run as the non-root "node" user that ships with the base image.
USER node

COPY --chown=node:node poker/package.json ./
RUN npm install --omit=dev

COPY --chown=node:node poker/server.js ./
COPY --chown=node:node poker/db ./db
COPY --chown=node:node poker/engine ./engine
COPY --chown=node:node poker/chain ./chain
COPY --chown=node:node poker/view.js ./
COPY --chown=node:node poker/public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
