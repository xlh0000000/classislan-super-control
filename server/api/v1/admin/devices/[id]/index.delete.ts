import { assertDeviceInScope, assertOrgNodeInScope } from "../../../../../utils/scope";
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  const device = db.prepare("SELECT id,name FROM devices WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM device_tags WHERE device_id=?").run(id);
      database.prepare("DELETE FROM commands WHERE device_id=?").run(id);
      database.prepare("DELETE FROM capability_snapshots WHERE device_id=?").run(id);
      database.prepare("DELETE FROM devices WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "device.delete", targetType: "device", targetId: id, summary: `删除设备 ${device.name}` }),
  );
  return { id, deleted: true };
});