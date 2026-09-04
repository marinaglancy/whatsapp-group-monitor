FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/web/static ./dist/web/static

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "dist/index.js"]
