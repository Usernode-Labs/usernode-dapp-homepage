FROM node:20-alpine

WORKDIR /app

# Run as the non-root "node" user that ships with the base image.
USER node

# This repo has no package.json; it's just static files + server.js.
COPY --chown=node:node server.js index.html dapps.json ./

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# Basic healthcheck (busybox provides wget on alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

