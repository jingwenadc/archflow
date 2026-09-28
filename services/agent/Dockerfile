FROM node:22-alpine AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY services/agent/package.json services/agent/package.json
RUN pnpm --filter @archflow/agent install --frozen-lockfile --ignore-scripts
COPY services/agent/tsconfig.json services/agent/tsconfig.json
COPY services/agent/src services/agent/src
RUN pnpm --filter @archflow/agent build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/services/agent/node_modules ./services/agent/node_modules
COPY --from=builder --chown=node:node /app/services/agent/package.json ./services/agent/package.json
COPY --from=builder --chown=node:node /app/services/agent/dist ./services/agent/dist
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const fs=require('fs');try{if(Date.now()-Number(fs.readFileSync('/tmp/archflow-agent-health','utf8'))>60000)process.exit(1)}catch{process.exit(1)}"
CMD ["node", "services/agent/dist/worker.js"]
