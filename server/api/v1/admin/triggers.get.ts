import { z } from "zod";
import { scheduleVisibleWhere } from "../../../utils/auto-tasks";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  state: z.enum(["active", "paused"]).optional(),
});

function parseCondition(kind: string, raw: Record<string, unknown>) {
  const condition = JSON.parse(raw.condition as string) as Record<string, number>;
  if (kind === "device_offline") return { offlineMinutes: condition.offlineMinutes ?? 30 };
  return { crashCount: condition.count ?? 3, windowMinutes: condition.windowMinutes ?? 60 };
}

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.read");
  const query = querySchema.safeParse(getQuery(event));
  if (!query.success) throw createError({ statusCode: 400, message: "触发器查询参数无效。" });
  const db = useDatabase();
  const visible = scheduleVisibleWhere(user);
  const where = query.data.state ? `${visible.sql} AND t.state=?` : visible.sql;
  const params = query.data.state ? [...visible.params, query.data.state] : [...visible.params];
  const total = (db.prepare(`SELECT COUNT(*) count FROM triggers t WHERE ${where}`).get(...params) as { count: number }).count;
  const offset = (query.data.page - 1) * query.data.pageSize;
  const rows = db.prepare(`SELECT t.*,u.display_name createdByName FROM triggers t LEFT JOIN users u ON u.id=t.created_by
    WHERE ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).all(...params, query.data.pageSize, offset) as Record<string, unknown>[];
  const items = rows.map((row) => ({
    id: row.id, name: row.name, kind: row.kind, ...parseCondition(row.kind as string, row),
    scopeType: row.scope_type, scopeId: row.scope_id,
    targets: JSON.parse(row.targets as string),
    capabilityId: row.capability_id, payload: JSON.parse(row.payload as string),
    ttlMinutes: row.ttl_minutes, cooldownMinutes: row.cooldown_minutes,
    state: row.state, lastFiredAt: row.last_fired_at, lastTaskId: row.last_task_id, lastError: row.last_error,
    createdBy: row.created_by, createdByName: row.createdByName,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  return { items, total, page: query.data.page, pageSize: query.data.pageSize };
});
