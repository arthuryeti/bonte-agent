FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
# The root test suite also covers this pure web formatting helper. Copy only
# the files it imports instead of pulling the full Next.js app into this image.
COPY web/app/lead-message.ts web/app/chat-types.ts ./web/app/

# Coolify exposes configured build arguments to RUN instructions. Keep unit
# tests isolated from the production database URL injected during deployment.
RUN NODE_ENV=test DATABASE_URL= DATABASE_HOST= npm test
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /app/.whatsapp-auth /app/output/pdf \
    && chown -R node:node /app/.whatsapp-auth /app/output

USER node

EXPOSE 8787

CMD ["node", "dist/gateway-server.js"]
