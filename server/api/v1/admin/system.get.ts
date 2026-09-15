export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "system.read");
  assertSchoolWideScope(user, "系统与备份");
  const db = useDatabase();
  const initialized = db.prepare("SELECT value FROM system_state WHERE key='initialized'").get() as { value: string } | undefined;
  const lastBackup = db.prepare("SELECT value FROM system_state WHERE key='last_backup_at'").get() as { value: string } | undefined;
  let backups: { name: string; ok: boolean; createdAt: string | null; sizeBytes: number }[] = [];
  try {
    backups = listBackups().map((entry) => ({
      name: entry.name,
      ok: entry.verification.ok,
      createdAt: entry.verification.manifest?.createdAt ?? null,
      sizeBytes: entry.verification.manifest?.files.reduce((total, file) => total + file.sizeBytes, 0) ?? 0,
    }));
  } catch { backups = []; }
  return {
    initialized: initialized?.value === "true",
    database: "SQLite WAL",
    version: "0.1.0",
    lastBackupAt: lastBackup?.value ?? null,
    backups,
  };
});