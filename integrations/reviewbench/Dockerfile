# ReviewBench image: the agent reviewer on one mounted pull request.
# Build from the repository root:
#   docker build --platform linux/amd64 -f integrations/reviewbench/Dockerfile -t pr-review-reviewbench:dev .
# Credentials arrive at run time (ANTHROPIC_API_KEY for Claude Code, OPENAI_API_KEY for Codex);
# none are baked into the image.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.296 @openai/codex@0.159.1 \
    && npm cache clean --force \
    && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY integrations/reviewbench/adapter.mjs ./integrations/reviewbench/adapter.mjs
# ReviewBench allows only the model API host; skip Claude Code's optional traffic.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1
ENTRYPOINT ["node", "/app/integrations/reviewbench/adapter.mjs"]

