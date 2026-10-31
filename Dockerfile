# HeLa Runtime daemon
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# runtime needs sibling ecosystem for inventory; mount at /ecosystem
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
ENV HELA_ECOSYSTEM_ROOT=/ecosystem
EXPOSE 8787
CMD ["node", "dist/index.js"]