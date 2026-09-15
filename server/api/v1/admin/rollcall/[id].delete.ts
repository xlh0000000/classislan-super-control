import { deleteRollCallRoster } from "../../../../utils/rollcall";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.write");
  assertSchoolWideScope(user, "点名名单");
  const id = getRouterParam(event, "id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 400, message: "名单 ID 无效。" });
  if (!deleteRollCallRoster(useDatabase(), user, id)) throw createError({ statusCode: 404, message: "名单不存在。" });
  return { ok: true };
});