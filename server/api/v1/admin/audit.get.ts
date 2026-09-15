import { z } from "zod";

const querySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  action: z.string().max(64).optional(),
  targetType: z.string().max(64).optional(),
  actorId: z.string().max(64).optional(),
});

export default defineEventHandler((event) => {
  requirePermission(event.context.user as { role: string }, "audit.read");
  const query = querySchema.safeParse(getQuery(event));
  if (!query.success) throw createError({ statusCode: 400, message: "审计查询参数无效。" });
  const db = useDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.data.action) { conditions.push("action=?"); params.push(query.data.action); }
  if (query.data.targetType) { conditions.push("target_type=?"); params.push(query.data.targetType); }
  if (query.data.actorId) { conditions.push("actor_id=?"); params.push(query.data.actorId); }
  if (query.data.cursor) { conditions.push("sequence<=?"); params.push(query.data.cursor); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT id,sequence,actor_type actorType,actor_id actorId,action,target_type targetType,target_id targetId,summary,details,previous_hash previousHash,created_at createdAt,event_hash eventHash
    FROM audit_events ${where} ORDER BY sequence DESC LIMIT ?`).all(...params, query.data.limit + 1) as Record<string, unknown>[];
  const hasMore = rows.length > query.data.limit;
  const items = rows.slice(0, query.data.limit);
  const last = items.length ? (items[items.length - 1] as { sequence: number }).sequence : null;
  return { items, nextCursor: hasMore ? last : null };
});