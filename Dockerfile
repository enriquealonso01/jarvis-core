FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
# Last-resort Supervisor route (ADR 006 / INITIAL_MODEL_ROUTING): Claude on the
# operator's subscription. The session itself is never baked in — it is read at
# runtime from the bind-mounted profile dir. Only the binary lives here.
RUN npm install -g @anthropic-ai/claude-code@2.1.252
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY migrations ./migrations
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
