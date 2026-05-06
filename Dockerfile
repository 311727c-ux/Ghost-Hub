FROM node:20-alpine

# Install pnpm
RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace config files first
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all packages
COPY lib/ ./lib/
COPY artifacts/ ./artifacts/
COPY tsconfig.base.json tsconfig.json ./

# Install all dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --no-frozen-lockfile --ignore-scripts

# Build the api-server
RUN pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
ENV FORCE_BOT_START=true
ENV PORT=8080

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
