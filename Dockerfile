FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/build.cjs ./scripts/build.cjs
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS service
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY scripts/admin.cjs ./scripts/admin.cjs
COPY scripts/api-key.cjs ./scripts/api-key.cjs
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
