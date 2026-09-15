import { z } from "zod";
import { assertDeviceInScope } from "../../../../../utils/scope";
import { bumpDesiredStateEpoch } from "../../../../../utils/policy";
import { deviceTransportSchema } from "../../../../../../shared/schemas";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  orgNodeId: z.string().uuid().nullable().optional(),
  tagIds: z.array(z.string().uuid()).max(64).optional(),
  // 连接模式：http 短轮询 / websocket 常驻长连接。改动会随下一次轮询或长连接响应送达设备。
  transport: deviceTransportSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const input = patchSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "设备更新信息无效。" });
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  const device = db.prepare("SELECT id,name FROM devices WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  if (input.data.orgNodeId !== undefined && input.data.orgNodeId !== null && !db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(input.data.orgNodeId))
    throw createError({ statusCode: 400, message: "目标组织不存在。" });
  if (input.data.orgNodeId) assertOrgNodeInScope(db, user, input.data.orgNodeId);
  const tagIds = input.data.tagIds ? [...new Set(input.data.tagIds)] : null;
  if (tagIds && tagIds.length !== input.data.tagIds!.length) throw createError({ statusCode: 400, message: "标签列表包含重复项。" });
  if (tagIds?.length) {
    const placeholders = tagIds.map(() => "?").join(",");
    const count = (db.prepare(`SELECT COUNT(*) count FROM tags WHERE id IN (${placeholders})`).get(...tagIds) as { count: number }).count;
    if (count !== tagIds.length) throw createError({ statusCode: 400, message: "标签列表包含不存在的标签。" });
  }
  const changedAt = nowIso();
  // 组织归属或标签集合变化会改变该设备的有效策略，必须推进期望状态 epoch。
  const membershipChanged = input.data.orgNodeId !== undefined || tagIds !== null;
  withAuditedTransaction(
    (database) => {
      if (input.data.name) database.prepare("UPDATE devices SET name=?,disabled_at=NULL WHERE id=?").run(input.data.name, id);
      if (input.data.orgNodeId !== undefined) {
        if (input.data.orgNodeId === null) database.prepare("UPDATE devices SET org_node_id=NULL WHERE id=?").run(id);
        else database.prepare("UPDATE devices SET org_node_id=? WHERE id=?").run(input.data.orgNodeId, id);
      }
      if (input.data.transport)
        database.prepare("UPDATE devices SET transport=? WHERE id=?").run(input.data.transport, id);
      if (tagIds) {
        database.prepare("DELETE FROM device_tags WHERE device_id=?").run(id);
        const addTag = database.prepare("INSERT INTO device_tags (device_id,tag_id) VALUES (?,?)");
        for (const tagId of tagIds) addTag.run(id, tagId);
      }
      if (membershipChanged) bumpDesiredStateEpoch(database, changedAt);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "device.update", targetType: "device", targetId: id, summary: `更新设备 ${device.name}`, details: { fields: Object.keys(input.data) } }),
  );
  return { id, updatedAt: changedAt };
});