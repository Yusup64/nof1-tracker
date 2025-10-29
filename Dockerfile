# syntax=docker/dockerfile:1

FROM node:20-slim AS base
WORKDIR /app

# Install dependencies (including devDependencies for the build)
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY docs ./docs
COPY dashboard ./dashboard
RUN npm run build
RUN npm prune --omit=dev

# Final lightweight runtime image
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy production node_modules and compiled output
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY docs ./docs
COPY --from=build /app/dashboard ./dashboard

# Ensure writable directory for runtime caches/order history
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENTRYPOINT ["node", "dist/index.js"]
CMD []
