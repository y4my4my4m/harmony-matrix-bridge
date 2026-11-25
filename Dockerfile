# Harmony Matrix bridge
# ghcr.io/y4my4my4m/harmony-matrix-bridge

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=9009
WORKDIR /app
COPY package.json package-lock.json ./
# /data: managed start. /app/data: config.json's default database. Named volumes inherit the node owner.
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data /app/data && chown node:node /data /app/data
COPY --from=build /app/dist ./dist
COPY LICENSE COPYRIGHT LICENSE-ADDITIONAL-TERMS.md TRADEMARK.md ./
USER node
VOLUME ["/data"]
EXPOSE 9009
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LISTEN_PORT||9009)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
