FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
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
