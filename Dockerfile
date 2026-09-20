FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 带 binding.gyp，npm 会隐式跑 node-gyp 编译；slim 镜像没有 python3/make/g++，缺一样都装不上依赖
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set python /usr/bin/python3
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000 CLASSISLAND_CONTROL_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/.output ./.output
RUN mkdir /data && chown -R node:node /app /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)})"
CMD ["node", ".output/server/index.mjs"]
