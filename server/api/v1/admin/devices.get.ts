import { deviceScopeFilter } from "../../../utils/scope";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.read");
  const db = useDatabase();
  const scope = deviceScopeFilter(db, user);
  const rows = db.prepare(`SELECT d.id,d.name,d.org_node_id orgNodeId,d.plugin_version pluginVersion,d.app_version appVersion,d.transport transport,d.last_seen_at lastSeen,d.disabled_at disabledAt,
    COALESCE(o.name,'未分组') orgName,
    CASE WHEN d.disabled_at IS NULL AND unixepoch(d.last_seen_at) > unixepoch('now')-45 THEN 1 ELSE 0 END online
    FROM devices d LEFT JOIN org_nodes o ON o.id=d.org_node_id WHERE ${scope.sql} ORDER BY d.name`).all(...scope.params) as {
      id: string; name: string; orgNodeId: string | null; pluginVersion: string; appVersion: string; transport: string; lastSeen: string | null; disabledAt: string | null; orgName: string; online: number;
    }[];
  // 标签随设备一起返回，供目标树在客户端解析“标签 → 设备”并统计受影响范围。
  const tags = db.prepare(`SELECT dt.device_id deviceId,dt.tag_id tagId FROM device_tags dt JOIN devices d ON d.id=dt.device_id WHERE ${scope.sql}`).all(...scope.params) as { deviceId: string; tagId: string }[];
  const byDevice = new Map<string, string[]>();
  for (const row of tags) {
    const list = byDevice.get(row.deviceId);
    if (list) list.push(row.tagId);
    else byDevice.set(row.deviceId, [row.tagId]);
  }
  return rows.map((row) => ({ ...row, online: row.online === 1, disabled: row.disabledAt !== null, tagIds: byDevice.get(row.id) ?? [] }));
});