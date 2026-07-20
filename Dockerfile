FROM node:24-alpine

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

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline && \
  rm -rf patches

# 環境変数でデータディレクトリを /data に設定
ENV COOKIE_FILE_PATH=/data/vrchat-cookies.json
ENV LOCATION_FILE_PATH=/data/user-locations.json

VOLUME ["/data"]

ENV NODE_ENV=production

ENTRYPOINT [ "pnpm", "start" ]
