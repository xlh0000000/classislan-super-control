# 构建阶段用非 slim 镜像：它自带 python3/make/g++，better-sqlite3 的 binding.gyp 会被 npm 隐式编译
# （apt 装这三样在 CI 里同样跑不起来，索性不依赖装包）；运行阶段仍用 slim，最终镜像体积不变。
FROM node:24.15.0-bookworm AS build
WORKDIR /app
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
