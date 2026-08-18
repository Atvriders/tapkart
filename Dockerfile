# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /src

COPY . .

# Install exactly the dependency graph recorded in the workspace lockfile.
RUN npm ci

# Build the shipped artifacts in dependency order.
RUN npm run build -w @tapkart/web
RUN npm run build -w @tapkart/server
RUN mkdir -p /out && npm exec -- esbuild apps/web/tools/write-assetlinks.ts \
      --bundle --platform=node --format=esm --outfile=/out/write-assetlinks.mjs

# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app

COPY --from=build --chown=node:node /src/packages/server/dist/main.mjs /app/main.mjs
COPY --from=build --chown=node:node /src/apps/web/dist /app/web
COPY --from=build --chown=node:node /out/write-assetlinks.mjs /app/tools/write-assetlinks.mjs
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh

# The entrypoint writes the generated statement below STATIC_ROOT as `node`.
RUN mkdir -p /app/web/.well-known && chown -R node:node /app/web/.well-known \
    && chmod +x /app/entrypoint.sh

ENV BIND_HOST=0.0.0.0
ENV STATIC_ROOT=/app/web
ENV SHADOW_ENABLED=true

USER node
EXPOSE 3031

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.PORT||'3031';fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
