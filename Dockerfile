FROM oven/bun:1.3.14-debian AS build

WORKDIR /app
ARG SELFBENCH_BUILD_COMMIT
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN if [ -f tsconfig.build.json ]; then bun run build; else test -f dist/api-main.js; fi
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM docker:29.4.0-cli AS docker-cli

FROM node:22-bookworm

ARG HARBOR_VERSION=0.20.1.dev202608040148
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl gh git jq ripgrep tar \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/0.11.3/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
  && env UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --python 3.12 "harbor[modal]==${HARBOR_VERSION}" \
  && chmod -R a+rX /opt/uv-python /opt/uv-tools
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

ENV NODE_ENV=production
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
WORKDIR /app
RUN mkdir -p /var/lib/selfbench/artifacts && chown -R node:node /var/lib/selfbench
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/extensions ./src/extensions
COPY --from=build /app/src/skills ./src/skills
COPY package.json ./package.json

USER node
CMD ["node", "dist/api-main.js"]
