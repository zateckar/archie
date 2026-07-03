# Stage 1: Build the SvelteKit app using Node.js
FROM node:24-slim AS builder

# Install build dependencies for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Final production image
FROM node:24-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libsqlite3-0 \
    libcurl4 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure data directory exists
RUN mkdir -p data extensions

# Copy build output, package.json, and production-ready node_modules from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/rag.db

EXPOSE 3000

# Run with Node.js for stable native better-sqlite3 support
CMD ["node", "build/index.js"]
