FROM node:20-alpine AS base

WORKDIR /app
ARG TARGETPLATFORM
ENV DASHDOT_IMAGE=base
ENV DASHDOT_RUNNING_IN_DOCKER=true

RUN \
  apk update &&\
  apk --no-cache add \
    lsblk \
    mdadm \
    dmidecode \
    coreutils \
    util-linux \
    lm-sensors \
    smartmontools \
    speedtest-cli &&\
  if [ "$TARGETPLATFORM" = "linux/amd64" ] || [ "$(uname -m)" = "x86_64" ]; \
    then \
      wget -qO- https://install.speedtest.net/app/cli/ookla-speedtest-1.1.1-linux-x86_64.tgz \
        | tar xmoz -C /usr/bin speedtest; \
  elif [ "$TARGETPLATFORM" = "linux/arm64" ] || [ "$(uname -m)" = "aarch64" ]; \
    then \
      wget -qO- https://install.speedtest.net/app/cli/ookla-speedtest-1.1.1-linux-aarch64.tgz \
        | tar xmoz -C /usr/bin speedtest &&\
      apk --no-cache add raspberrypi; \
  elif [ "$TARGETPLATFORM" = "linux/arm/v7" ]; \
    then \
      wget -qO- https://install.speedtest.net/app/cli/ookla-speedtest-1.1.1-linux-armhf.tgz \
        | tar xmoz -C /usr/bin speedtest &&\
      apk --no-cache add raspberrypi; \
  else echo "Unsupported platform"; exit 1; \
  fi

FROM base AS build

WORKDIR /src
ARG DASHDOT_REF=main
ARG BUILDHASH=overlay
ARG VERSION=overlay

RUN apk --no-cache add git make clang build-base bash
RUN git clone --depth 1 --branch ${DASHDOT_REF} https://github.com/MauriceNino/dashdot.git .

COPY apply-dashdot-smart-patch.mjs /tmp/apply-dashdot-smart-patch.mjs
RUN node /tmp/apply-dashdot-smart-patch.mjs

RUN corepack enable
RUN echo "{\"version\":\"$VERSION\",\"buildhash\":\"$BUILDHASH\"}" > /src/version.json
RUN yarn --immutable && yarn build:prod && node scripts/strip_package_json.js

FROM base AS prod

ENV NODE_ENV=production
EXPOSE 3001

COPY --from=build /src/version.json /app/version.json
COPY --from=build /src/.yarn/releases /app/.yarn/releases
COPY --from=build /src/.yarnrc.yml /app/.yarnrc.yml
COPY --from=build /src/apps/server/dist /app/server/dist
COPY --from=build /src/apps/view/dist /app/view/dist
COPY --from=build /src/apps/cli/dist /app/cli/dist
COPY --from=build /src/dist/package.json /app/package.json

RUN corepack enable && yarn

CMD ["node", "server/dist/index.cjs"]
