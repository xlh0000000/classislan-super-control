import { crashGroups, crashStats } from "../../../utils/crash-reports";
import { deviceScopeFilter } from "../../../utils/scope";

/** 崩溃上报查询：统计、指纹分组与筛选条件一次返回，页面上只需一次请求。 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "crashes.read");
  const db = useDatabase();
  const query = getQuery(event);
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const days = Math.min(Math.max(Number(query.days ?? 14) || 14, 1), 90);
  const deviceId = text(query.deviceId);
  const kind = text(query.kind);
  const fingerprint = text(query.fingerprint);
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
  // 浏览器上报的时区偏移：逐日曲线按调用方本地自然日归组，避免跨时区错位。
  const tzOffsetMinutes = Math.min(Math.max(Number(query.tzOffsetMinutes ?? 0) || 0, -900), 900);
  const filters = { scope: deviceScopeFilter(db, user, "cr"), days, deviceId, kind, fingerprint };
  return {
    stats: crashStats(db, { ...filters, tzOffsetMinutes }),
    groups: crashGroups(db, { ...filters, limit }),
    filters: { days, deviceId, kind, fingerprint },
  };
});