FROM node:24-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY apps/web apps/web
# skip bundled ffmpeg download inside the image; system ffmpeg is installed above
RUN pnpm build

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV CHECKARR_DATA_DIR=/data
# Bind every interface inside the container; docker-compose publishes the
# port to host loopback only. The API is unauthenticated - keep it that way
# unless you consciously want it on the LAN (and set CHECKARR_ALLOWED_HOSTS).
ENV HOST=0.0.0.0
COPY --from=build /app ./
# Run as the unprivileged node user. Fresh data volumes inherit this image's
# /data ownership. Upgrading from an image that ran as root? Migrate once:
#   docker compose run --rm --user root chown -R node:node /data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5656
CMD ["node", "apps/server/dist/index.js"]
