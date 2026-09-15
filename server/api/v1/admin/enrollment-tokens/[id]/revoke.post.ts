export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "enrollment.write");
  assertSchoolWideScope(user, "设备接入凭据");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const token = db.prepare("SELECT id,revoked_at revokedAt FROM enrollment_tokens WHERE id=?").get(id) as { id: string; revokedAt: string | null } | undefined;
  if (!token) throw createError({ statusCode: 404, message: "接入凭据不存在。" });
  if (token.revokedAt) throw createError({ statusCode: 409, message: "接入凭据已撤销。" });
  const changedAt = nowIso();
  withAuditedTransaction(
    (database) => {
      database.prepare("UPDATE enrollment_tokens SET revoked_at=? WHERE id=?").run(changedAt, id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "enrollment.revoke", targetType: "enrollment_token", targetId: id, summary: "撤销接入凭据" }),
  );
  return { id, revokedAt: changedAt };
});