export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "system.write");
  assertSchoolWideScope(user, "系统与备份");
  const db = useDatabase();
  const signing = getServerSigningIdentity();
  const { directory, manifest } = await createBackup(db, {
    dataDir: dataDirectory(),
    signingKeyId: signing.keyId,
  });
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('last_backup_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .run(manifest.createdAt, manifest.createdAt);
      return manifest.createdAt;
    },
    () => ({ actorType: "user", actorId: user.id, action: "system.backup", targetType: "system", summary: "创建一致性备份 bundle", details: { createdAt: manifest.createdAt, files: manifest.files.length } }),
  );
  return { directory: directory.split(/[\\/]/).pop(), manifest };
});