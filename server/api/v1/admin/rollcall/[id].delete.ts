import { deleteRollCallRoster } from "../../../../utils/rollcall";
import { assertDeviceInScope, isTeacher } from "../../../../utils/scope";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.write");
  const id = getRouterParam(event, "id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 400, message: "名单 ID 无效。" });
  const db = useDatabase();
  if (isTeacher(user)) {
    // 教师删除的只能是自己设备的那份覆盖名单；全校/组织名单对他不可见也不可动。
    const roster = db.prepare("SELECT scope_type scopeType,scope_id scopeId FROM rollcall_rosters WHERE id=?").get(id) as
      { scopeType: string; scopeId: string | null } | undefined;
    if (!roster) throw createError({ statusCode: 404, message: "名单不存在。" });
    if (roster.scopeType !== "device" || !roster.scopeId)
      throw createError({ statusCode: 403, message: "教师只能删除自己设备上的点名名单。" });
    assertDeviceInScope(db, user, roster.scopeId);
  } else {
    assertSchoolWideScope(user, "点名名单");
  }
  if (!deleteRollCallRoster(db, user, id)) throw createError({ statusCode: 404, message: "名单不存在。" });
  return { ok: true };
});
