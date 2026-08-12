FROM node:22-bookworm-slim AS dependencies

WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM dependencies AS build

WORKDIR /app
COPY web ./web
COPY src/gateway/crm-ui-types.ts ./src/gateway/crm-ui-types.ts
COPY src/gateway/web-event-cursor.ts ./src/gateway/web-event-cursor.ts

WORKDIR /app/web
RUN BETTER_AUTH_SECRET=build-only-secret-that-is-never-used-at-runtime \
    BETTER_AUTH_URL=http://localhost:3000 \
    npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /app/web/.next/standalone ./
COPY --from=build --chown=node:node /app/web/public ./web/public
COPY --from=build --chown=node:node /app/web/.next/static ./web/.next/static
COPY --from=build --chown=node:node /app/web/drizzle ./drizzle

USER node

EXPOSE 3000

CMD ["node", "web/server.js"]
