FROM node:20-alpine

WORKDIR /app

# Give the non-root "node" user ownership of the workdir so it can write
# node_modules during the install step below.
RUN chown node:node /app

# Run as the non-root "node" user that ships with the base image.
USER 1000

COPY --chown=node:node package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node db ./db
COPY --chown=node:node engine ./engine
COPY --chown=node:node chain ./chain
COPY --chown=node:node view.js ./
COPY --chown=node:node public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Drop to non-root user at runtime only (after build steps complete as root).
# By NUMBER (the image's `node` user is UID 1000): the platform runs containers
# with runAsNonRoot, which cannot verify a named user.
USER 1000
CMD ["node", "server.js"]
