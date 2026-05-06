FROM node:20-alpine

RUN npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
ENV FORCE_BOT_START=true
ENV PORT=8080

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
