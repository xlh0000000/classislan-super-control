import { getHeader, getMethod } from "h3";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default defineEventHandler((event) => {
  const path = event.path.split("?")[0] || "/";
  if (!path.startsWith("/api/v1/admin/")) return;
  const user = requireUser(event);
  event.context.user = user;
  if (!MUTATING.has(getMethod(event))) return;
  const origin = getHeader(event, "origin");
  const host = getHeader(event, "host");
  if (!origin || !host) throw createError({ statusCode: 403, message: "缺少同源请求证明。" });
  const url = new URL(origin);
  if (url.host !== host) throw createError({ statusCode: 403, message: "拒绝跨站管理请求。" });
});
