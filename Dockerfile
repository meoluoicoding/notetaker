# ---- builder: install deps + bundle the API server ----
FROM node:24 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build:ts

# ---- runtime: prod deps + built bundle + static assets ----
FROM node:24
ENV NODE_ENV=production PORT=3000
WORKDIR /app

# prod deps only. node_modules is also the /vendor/* source express mounts
# (codemirror, katex, mermaid…) and carries the better-sqlite3 native module.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public ./public

# SQLite db + Tantivy index live here (server auto-seeds an empty db on boot)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/index.mjs"]