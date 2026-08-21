# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
# Pinned to the BUILDER's architecture, not the target's. Everything this stage
# hands to the runtime stage is portable: a bundled ESM server, a bundled ESM
# assetlinks tool, and static web assets. None of it is architecture-specific,
# so building it once natively and copying it into both legs is not an
# optimisation that trades away correctness -- the bytes are identical either
# way.
#
# Without this, buildx runs the whole npm workspace build under QEMU for the
# arm64 leg. Measured on this repository: over ninety minutes, versus a few
# minutes native, for byte-identical output. The runtime stage below is
# deliberately NOT pinned -- that is where the per-architecture `node` binary
# comes from, and pinning it would produce an amd64 image wearing an arm64 tag.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
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

# Links the published package to this repository. Without it the image is still
# public and still pullable, but GitHub shows nothing under Packages on the
# repository page -- the package is reachable only by its direct URL or by
# searching the account's package list, which is where this one went missing.
LABEL org.opencontainers.image.source="https://github.com/Atvriders/tapkart" \
      org.opencontainers.image.url="https://github.com/Atvriders/tapkart" \
      org.opencontainers.image.title="Tapkart" \
      org.opencontainers.image.description="Mobile browser kart racer with NFC tap-to-join."

ENV BIND_HOST=0.0.0.0
ENV STATIC_ROOT=/app/web
ENV SHADOW_ENABLED=true

USER node
EXPOSE 3037

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.PORT||'3037';fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
