# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/jfvrc.db
EXPOSE 3000
USER node
CMD ["node", "dist/server/index.js"]
