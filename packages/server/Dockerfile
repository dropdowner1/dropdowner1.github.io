FROM node:22-alpine AS build
WORKDIR /app
# `git` is required because @colyseus/* pulls in
# @colyseus/uwebsockets-transport, which depends on uWebSockets.js
# via a git URL rather than the npm registry.
RUN apk add --no-cache git
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile --filter @chaindrop/shared... --filter @chaindrop/server...

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# We don't ship pre-compiled JS. The runtime image runs tsx against
# the TypeScript source — this dodges the Node-ESM extension-resolution
# headache and keeps @chaindrop/shared (a workspace package whose
# `main` points at `.ts`) resolvable.
RUN pnpm deploy --filter @chaindrop/server --prod /app/deploy


FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/deploy ./

EXPOSE 2567
CMD ["node", "--import", "tsx", "src/index.ts"]
