import { listCrashReports } from "../../../../utils/crash-reports";
import { deviceScopeFilter } from "../../../../utils/scope";

/** 崩溃明细：按指纹或设备展开原始报告，供详情弹窗查看堆栈。 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "crashes.read");
  const db = useDatabase();
  const query = getQuery(event);
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    reports: listCrashReports(db, {
      scope: deviceScopeFilter(db, user, "cr"),
      days: Math.min(Math.max(Number(query.days ?? 90) || 90, 1), 90),
      deviceId: text(query.deviceId),
      kind: text(query.kind),
      fingerprint: text(query.fingerprint),
      limit: Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500),
    }),
  };
});