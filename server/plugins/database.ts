import { defineNitroPlugin } from "nitropack/runtime/plugin";
import { closeDatabase, useDatabase } from "../utils/database";

export default defineNitroPlugin((nitroApp) => {
  try {
    useDatabase();
  } catch (error) {
    console.error("[classisland-control] 数据库初始化失败，服务拒绝启动：", error);
    throw error;
  }
  nitroApp.hooks.hook("close", () => {
    try {
      closeDatabase();
    } catch (error) {
      console.error("[classisland-control] 关闭数据库连接失败：", error);
    }
  });
});