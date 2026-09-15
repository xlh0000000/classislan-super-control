import { defineNitroPlugin } from "nitropack/runtime/plugin";
import { startTaskScheduler, stopTaskScheduler } from "../utils/scheduler";

export default defineNitroPlugin((nitroApp) => {
  startTaskScheduler();
  nitroApp.hooks.hook("close", () => stopTaskScheduler());
});