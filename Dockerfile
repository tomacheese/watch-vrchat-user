# Builder stage
FROM node:24-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

# hadolint ignore=DL3018
RUN apk update && \
  apk upgrade && \
  npm install -g corepack@latest && \
  corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json ./
COPY patches patches

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY tsconfig.json ./
COPY src src

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline

# Runner stage
FROM node:24-alpine AS runner

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

# hadolint ignore=DL3018
RUN apk update && \
  apk upgrade && \
  apk add --update --no-cache tzdata && \
  cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime && \
  echo "Asia/Tokyo" > /etc/timezone && \
  apk del tzdata && \
  npm install -g corepack@latest && \
  corepack enable

WORKDIR /app

# Builder から必要なファイルのみコピー
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# 環境変数でデータディレクトリを /data に設定
ENV COOKIE_FILE_PATH=/data/vrchat-cookies.json
ENV LOCATION_FILE_PATH=/data/user-locations.json

VOLUME ["/data"]

ENV NODE_ENV=production

ENTRYPOINT [ "pnpm", "start" ]
