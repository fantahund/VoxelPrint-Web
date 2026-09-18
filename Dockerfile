# Build stage: install everything and compile both workspaces.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage: production dependencies and the compiled output only.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace @voxelprint/server

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

ENV PORT=3000 \
    HOST=0.0.0.0 \
    VOXELPRINT_DATA_DIR=/data \
    VOXELPRINT_WEB_ROOT=/app/web/dist

# Pre-create the data directory and set ownership so named volumes inherit it.
RUN mkdir /data && chown node:node /data

# Uploaded projects live outside the image.
VOLUME ["/data"]
EXPOSE 3000

# Not root: an upload handler should never run with more rights than it needs.
USER node

CMD ["node", "server/dist/index.js"]
