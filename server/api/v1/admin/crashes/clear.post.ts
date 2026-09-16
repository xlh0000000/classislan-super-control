import { z } from "zod";
import { clearCrashReports } from "../../../../utils/crash-reports";
import { appendAuditWithin } from "../../../../utils/security";
import { deviceScopeFilter } from "../../../../utils/scope";

/** 清除条件：都不给表示清空全部（仍受账号组织范围限制）。 */
const clearSchema = z.object({
  fingerprint: z.string().trim().min(4).max(64).optional(),
  deviceId: z.string().uuid().optional(),
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "crashes.write");
  const parsed = clearSchema.safeParse((await readBody(event)) ?? {});
  if (!parsed.success) throw createError({ statusCode: 400, message: "清除条件无效。" });
  const db = useDatabase();
  const { fingerprint, deviceId } = parsed.data;
  const removed = db
    .transaction(() => {
      const count = clearCrashReports(db, {
        scope: deviceScopeFilter(db, user, "cr"),
        fingerprint: fingerprint ?? null,
        deviceId: deviceId ?? null,
      });
      if (count > 0)
        appendAuditWithin(db, {
          actorType: "user", actorId: user.id, action: "crash.reports.clear", targetType: "crash",
          targetId: fingerprint ?? deviceId ?? "all",
          summary: `清除 ${count} 条崩溃上报`,
          details: { fingerprint: fingerprint ?? null, deviceId: deviceId ?? null },
        });
      return count;
    })
    .immediate();
  return { removed };
});