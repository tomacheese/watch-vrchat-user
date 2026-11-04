FROM node:26.13.0-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

# hadolint ignore=DL3018
RUN apk update && \
  apk upgrade && \
  apk add --update --no-cache tzdata curl && \
  cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime && \
  echo "Asia/Tokyo" > /etc/timezone && \
  apk del tzdata && \
  npm install -g corepack@latest && \
  corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY patches patches

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY tsconfig.json ./
COPY src src

# Keep patches in the runtime image: the dependency check run by `pnpm start` (ENTRYPOINT) also reads them
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline

# Point the data paths at /data via environment variables
ENV COOKIE_FILE_PATH=/data/vrchat-cookies.json
ENV STATE_FILE_PATH=/data/friend-states.json
ENV WORLD_CACHE_FILE_PATH=/data/world-cache.json
ENV OWNER_CACHE_FILE_PATH=/data/owner-cache.json
ENV CONFIG_PATH=/data/config.yaml

VOLUME ["/data"]

ENV NODE_ENV=production

ENTRYPOINT [ "pnpm", "start" ]
