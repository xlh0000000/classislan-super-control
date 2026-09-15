import { roomDevicesSchema } from "../../../../../../../shared/schemas";
import { assertDeviceInScope } from "../../../../../../utils/scope";
import { assignRoomDevices, roomDeviceIds } from "../../../../../../utils/layout";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const input = roomDevicesSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "设备分配信息无效。" });
  const db = useDatabase();
  const room = db.prepare("SELECT id,name FROM building_rooms WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!room) throw createError({ statusCode: 404, message: "教室不存在。" });
  for (const deviceId of new Set([...input.data.add, ...input.data.remove])) {
    assertDeviceInScope(db, user, deviceId);
    if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(deviceId))
      throw createError({ statusCode: 400, message: "设备不存在。" });
  }
  withAuditedTransaction(
    (database) => {
      assignRoomDevices(database, id, input.data.add, input.data.remove);
      return roomDeviceIds(database, id);
    },
    (deviceIds) => ({
      actorType: "user", actorId: user.id, action: "layout.room.assign", targetType: "building_room", targetId: id,
      summary: `${room.name} 教室设备更新（共 ${deviceIds.length} 台）`,
      details: { added: input.data.add.length, removed: input.data.remove.length },
    }),
  );
  return { id, deviceIds: roomDeviceIds(db, id) };
});