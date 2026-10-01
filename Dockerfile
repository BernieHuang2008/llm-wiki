# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ pkg-config libsecret-1-dev \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @llm-wiki/web build

FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV LLM_WIKI_PATH=/data/wiki
# Bind the MCP server to every interface: inside a container, 127.0.0.1 is
# unreachable from the host even with -p 3738:3738. `allowRemote` in
# Settings → MCP still has to be on before an unauthenticated request is let in.
ENV LLM_WIKI_MCP_HOST=0.0.0.0
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs llmwiki

COPY --from=builder /app/apps/web/.next/standalone ./
COPY docker/entrypoint.sh /app/docker/entrypoint.sh

VOLUME ["/data/wiki"]
EXPOSE 3000 3738

RUN mkdir -p /data/wiki /.llm-wiki \
  && chmod +x /app/docker/entrypoint.sh \
  && chown -R llmwiki:nodejs /app /data/wiki /.llm-wiki \
  && chmod -R 777 /.llm-wiki

USER llmwiki
CMD ["/app/docker/entrypoint.sh"]
