import { assertDeviceInScope, isTeacher } from "../../../../../../utils/scope";
import { unbindTeacher } from "../../../../../../utils/teacher-bindings";

/** 解绑：管理员可解任意一条；教师只能解除自己的绑定（设备可见性已由作用域把关）。 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "binding.write");
  const deviceId = getRouterParam(event, "id")!;
  const userId = getRouterParam(event, "userId")!;
  if (isTeacher(user) && userId !== user.id)
    throw createError({ statusCode: 403, message: "教师只能解除自己的设备绑定。" });
  const db = useDatabase();
  assertDeviceInScope(db, user, deviceId);
  if (!unbindTeacher(db, user.id, deviceId, userId))
    throw createError({ statusCode: 404, message: "该教师未绑定此设备。" });
  return { deviceId, userId, removed: true };
});
