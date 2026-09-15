export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "system.read");
  assertSchoolWideScope(user, "系统与备份");
  return listBackups().map((entry) => ({
    name: entry.name,
    ok: entry.verification.ok,
    reasons: entry.verification.reasons,
    createdAt: entry.verification.manifest?.createdAt ?? null,
    schemaVersion: entry.verification.manifest?.schemaVersion ?? null,
    signingKeyId: entry.verification.manifest?.signingKeyId ?? null,
    sizeBytes: entry.verification.manifest?.files.reduce((total, file) => total + file.sizeBytes, 0) ?? 0,
  }));
});