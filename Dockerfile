# Stage 1: Build the SvelteKit app
FROM node:lts-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
RUN npm install --no-save @sqliteai/sqlite-vector-linux-x64 || true
COPY . .
RUN npm run build

# Stage 2: Final image
FROM node:lts-slim
RUN apt-get update && apt-get install -y \
    libsqlite3-0 \
    libcurl4 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure data directory exists
RUN mkdir -p data extensions

# Copy build output and dependencies
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/rag.db

EXPOSE 3000
CMD ["node", "build"]
