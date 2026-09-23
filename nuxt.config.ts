import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 服务端版本只有这一个来源：构建期读 package.json，运行时两处接口各自取用。
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", import.meta.url)), "utf8")) as { version: string };
const appVersion = packageJson.version;

export default defineNuxtConfig({
  compatibilityDate: "2026-09-01",

  css: ["~/assets/css/main.css"],
  devtools: { enabled: false },
  devServer: { host: "127.0.0.1" },
  modules: ["@nuxtjs/i18n"],
  i18n: {
    defaultLocale: "zh-CN",
    strategy: "no_prefix",
    locales: [{ code: "zh-CN", language: "zh-CN", file: "zh-CN.json", name: "简体中文" }],
    langDir: "locales",
    detectBrowserLanguage: false,
  },
  nitro: {
    compressPublicAssets: true,
    experimental: {
      database: false,
      // 设备可按管理端指定的连接模式改用常驻 WebSocket（见 server/api/v1/agent/ws.ts）。
      websocket: true,
    },
  },
  runtimeConfig: {
    dataDir: process.env.CLASSISLAND_CONTROL_DATA_DIR || "./data",
    appVersion,
    public: {
      productName: "Classisland Super Control",
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
  vite: {
    build: {
      target: "es2022",
    },
  },
});
