import { deviceScopeFilter } from "../../../utils/scope";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "dashboard.read");
  const db = useDatabase();
  const scope = deviceScopeFilter(db, user);
  const devices = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN unixepoch(d.last_seen_at) > unixepoch('now')-45 THEN 1 ELSE 0 END) online,
    SUM(CASE WHEN d.drift_count > 0 THEN 1 ELSE 0 END) drifted
    FROM devices d WHERE d.disabled_at IS NULL AND ${scope.sql}`).get(...scope.params) as { total: number; online: number | null; drifted: number | null };
  const taskFilter = scope.sql === "1=1" ? "1=1" : `EXISTS (SELECT 1 FROM commands c JOIN devices d ON d.id=c.device_id WHERE c.task_id=t.id AND ${scope.sql})`;
  const tasks = db.prepare(`SELECT
    SUM(CASE WHEN t.state IN ('scheduled','running','paused','cancelling') THEN 1 ELSE 0 END) active,
    SUM(CASE WHEN t.state IN ('failed','partial_failure') THEN 1 ELSE 0 END) failed FROM tasks t WHERE ${taskFilter}`).get(...scope.params) as { active: number | null; failed: number | null };
  const revision = db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM policy_revisions").get() as { revision: number };
  const recentTasks = db.prepare(`SELECT t.id,t.name,t.capability_id capabilityId,t.state,t.created_at createdAt
    FROM tasks t WHERE ${taskFilter} ORDER BY t.created_at DESC LIMIT 5`).all(...scope.params) as Record<string, unknown>[];
  const recentAudit = db.prepare(`SELECT sequence,action,summary,actor_type actorType,created_at createdAt
    FROM audit_events ORDER BY sequence DESC LIMIT 6`).all() as Record<string, unknown>[];
  return {
    devices: { total: devices.total, online: devices.online ?? 0, drifted: devices.drifted ?? 0 },
    tasks: { active: tasks.active ?? 0, failed: tasks.failed ?? 0 },
    policyRevision: revision.revision,
    recent: { tasks: recentTasks, audit: recentAudit },
  };
});