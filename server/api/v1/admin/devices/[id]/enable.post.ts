import { assertDeviceInScope, assertOrgNodeInScope } from "../../../../../utils/scope";
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  const device = db.prepare("SELECT id,name,disabled_at disabledAt FROM devices WHERE id=?").get(id) as { id: string; name: string; disabledAt: string | null } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  if (!device.disabledAt) throw createError({ statusCode: 409, message: "设备未禁用。" });
  const changedAt = nowIso();
  withAuditedTransaction(
    (database) => {
      database.prepare("UPDATE devices SET disabled_at=NULL WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "device.enable", targetType: "device", targetId: id, summary: `恢复设备 ${device.name}` }),
  );
  return { id, enabledAt: changedAt };
});