FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

# App source.
COPY server.js ./
COPY index.html ./
COPY lib ./lib

ENV PORT=3000
EXPOSE 3000

# Drop to the unprivileged user the base image ships with.
USER node

CMD ["node", "server.js"]
