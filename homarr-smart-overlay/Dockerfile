# Build Homarr from upstream source and apply a tiny DashDot SMART patch at build time.
# This avoids maintaining a full fork while still keeping compatibility with new releases.

FROM node:24.13.1-alpine AS builder

RUN apk add --no-cache git libc6-compat curl bash
WORKDIR /src

ARG HOMARR_REF=main
RUN git clone --depth 1 --branch ${HOMARR_REF} https://github.com/homarr-labs/homarr.git .

COPY apply-dashdot-smart-patch.mjs /tmp/apply-dashdot-smart-patch.mjs
RUN node /tmp/apply-dashdot-smart-patch.mjs

RUN corepack enable pnpm && pnpm install --recursive --frozen-lockfile

# Keep these aligned with upstream build flags
ARG SKIP_ENV_VALIDATION=true
ARG CI=true
ARG DISABLE_REDIS_LOGS=true
RUN corepack enable pnpm && pnpm build

FROM node:24.13.1-alpine AS runner
WORKDIR /app

RUN apk add --no-cache redis nginx bash gettext su-exec openssl
RUN mkdir /appdata
VOLUME /appdata

# Enable homarr cli
COPY --from=builder /src/packages/cli/cli.cjs /app/apps/cli/cli.cjs
RUN echo $'#!/bin/bash\ncd /app/apps/cli && node ./cli.cjs "$@"' > /usr/bin/homarr
RUN chmod +x /usr/bin/homarr

# Runtime directories
RUN mkdir -p /var/cache/nginx && \
    mkdir -p /var/log/nginx && \
    mkdir -p /var/lib/nginx && \
    touch /run/nginx/nginx.pid && \
    mkdir -p /etc/nginx/templates /etc/nginx/ssl/certs

COPY --from=builder /src/apps/nextjs/next.config.ts .
COPY --from=builder /src/apps/nextjs/package.json .

COPY --from=builder /src/apps/tasks/tasks.cjs ./apps/tasks/tasks.cjs
COPY --from=builder /src/apps/websocket/wssServer.cjs ./apps/websocket/wssServer.cjs
COPY --from=builder /src/node_modules/better-sqlite3/build/Release/better_sqlite3.node /app/build/better_sqlite3.node

COPY --from=builder /src/packages/db/migrations ./db/migrations
COPY --from=builder /src/apps/nextjs/.next/standalone ./
COPY --from=builder /src/apps/nextjs/.next/static ./apps/nextjs/.next/static
COPY --from=builder /src/apps/nextjs/public ./apps/nextjs/public
COPY --from=builder /src/scripts/run.sh ./run.sh
COPY --from=builder /src/scripts/entrypoint.sh ./entrypoint.sh
COPY --from=builder /src/packages/redis/redis.conf /app/redis.conf
COPY --from=builder /src/nginx.conf /etc/nginx/templates/nginx.conf

RUN chmod +x /app/entrypoint.sh

ENV DB_URL='/appdata/db/db.sqlite'
ENV DB_DIALECT='sqlite'
ENV DB_DRIVER='better-sqlite3'
ENV AUTH_PROVIDERS='credentials'
ENV REDIS_IS_EXTERNAL='false'
ENV NODE_ENV='production'

ENTRYPOINT [ "/app/entrypoint.sh" ]
CMD ["sh", "run.sh"]
