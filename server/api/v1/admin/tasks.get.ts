import { z } from "zod";
import { deviceScopeFilter } from "../../../utils/scope";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  state: z.string().max(32).optional(),
});

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.read");
  const query = querySchema.safeParse(getQuery(event));
  if (!query.success) throw createError({ statusCode: 400, message: "任务查询参数无效。" });
  const db = useDatabase();
  const scope = deviceScopeFilter(db, user);
  const taskFilter = scope.sql === "1=1" ? "1=1" : `EXISTS (SELECT 1 FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.task_id=t.id AND ${scope.sql})`;
  const listWhere = query.data.state ? `${taskFilter} AND t.state=?` : taskFilter;
  const listParams: unknown[] = query.data.state ? [...scope.params, query.data.state] : [...scope.params];
  const total = (db.prepare(`SELECT COUNT(*) count FROM tasks t WHERE ${listWhere}`).get(...listParams) as { count: number }).count;
  const offset = (query.data.page - 1) * query.data.pageSize;
  const tasks = db.prepare(`SELECT t.id,t.name,t.capability_id capabilityId,t.state,t.scheduled_at scheduledAt,t.expires_at expiresAt,
    t.mode,t.batch_size batchSize,t.percent,t.failure_threshold failureThreshold,t.max_concurrency maxConcurrency,t.cancel_requested cancelRequested,t.last_error lastError,t.created_at createdAt
    FROM tasks t WHERE ${listWhere} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).all(...listParams, query.data.pageSize, offset) as {
      id: string; name: string; capabilityId: string; state: string; scheduledAt: string | null; expiresAt: string;
      mode: string; batchSize: number | null; percent: number | null; failureThreshold: number; maxConcurrency: number; cancelRequested: number; lastError: string | null; createdAt: string;
    }[];
  const items = tasks.map((task) => {
    const batches = db.prepare("SELECT state,COUNT(*) count FROM task_batches WHERE task_id=? GROUP BY state").all(task.id) as { state: string; count: number }[];
    const stats = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN c.state='succeeded' THEN 1 ELSE 0 END) succeeded,
      SUM(CASE WHEN c.state IN ('failed','conflict','unsupported') THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN c.state='expired' THEN 1 ELSE 0 END) expired,
      SUM(CASE WHEN c.state='cancelled' THEN 1 ELSE 0 END) cancelled,
      SUM(CASE WHEN c.state IN ('pending','offered','received','running','cancelling') THEN 1 ELSE 0 END) active
      FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.task_id=? AND ${scope.sql}`).get(task.id, ...scope.params) as { total: number; succeeded: number | null; failed: number | null; expired: number | null; cancelled: number | null; active: number | null };
    return {
      ...task,
      batches: Object.fromEntries(batches.map((batch) => [batch.state, batch.count])),
      stats: {
        total: stats.total,
        succeeded: stats.succeeded ?? 0,
        failed: stats.failed ?? 0,
        expired: stats.expired ?? 0,
        cancelled: stats.cancelled ?? 0,
        active: stats.active ?? 0,
      },
    };
  });
  return { items, total, page: query.data.page, pageSize: query.data.pageSize };
});