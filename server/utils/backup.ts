import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export const BACKUP_FORMAT_VERSION = 1;
export const DATABASE_FILE_NAME = "classisland-control.db";
const SIGNING_FILES = ["server-signing-private.pem", "server-signing-public.der"];

export type BackupFileEntry = { name: string; sha256: string; sizeBytes: number };

export type BackupManifest = {
  formatVersion: number;
  createdAt: string;
  schemaVersion: number;
  signingKeyId: string;
  files: BackupFileEntry[];
};

export type BackupVerification = {
  ok: boolean;
  reasons: string[];
  manifest: BackupManifest | null;
};

export function dataDirectory(): string {
  const config = useRuntimeConfig();
  return resolve(process.env.CLASSISLAND_CONTROL_DATA_DIR || config.dataDir);
}

export function backupsDirectory(): string {
  return resolve(dataDirectory(), "backups");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readManifest(directory: string): BackupManifest {
  return JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")) as BackupManifest;
}

export function schemaVersionOf(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
}

/**
 * 生成一致性备份 bundle：SQLite 在线备份 + 服务端签名密钥 + 清单。
 * 使用 SQLite backup API，而不是直接复制 WAL 主文件，避免遗漏已提交事务。
 */
export async function createBackup(
  db: Database.Database,
  options: { dataDir: string; backupsDir?: string; signingKeyId: string; now?: string },
): Promise<{ directory: string; manifest: BackupManifest }> {
  const now = options.now ?? new Date().toISOString();
  const root = options.backupsDir ?? resolve(options.dataDir, "backups");
  const directory = resolve(root, `backup-${now.replace(/[:.]/g, "-")}`);
  mkdirSync(directory, { recursive: true });
  await db.backup(resolve(directory, DATABASE_FILE_NAME));
  const files: BackupFileEntry[] = [];
  for (const name of [DATABASE_FILE_NAME, ...SIGNING_FILES]) {
    const source = resolve(options.dataDir, name);
    const target = resolve(directory, name);
    if (!existsSync(source)) continue;
    if (name !== DATABASE_FILE_NAME) copyFileSync(source, target);
    files.push({ name, sha256: sha256File(target), sizeBytes: statSync(target).size });
  }
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now,
    schemaVersion: schemaVersionOf(db),
    signingKeyId: options.signingKeyId,
    files,
  };
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { directory, manifest };
}

/** 校验备份 bundle：清单、逐文件哈希、SQLite 完整性、迁移版本与可选签名身份。 */
export function verifyBackup(directory: string, expectedSigningKeyId?: string): BackupVerification {
  const reasons: string[] = [];
  const manifestPath = resolve(directory, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, reasons: ["缺少 manifest.json"], manifest: null };
  let manifest: BackupManifest;
  try {
    manifest = readManifest(directory);
  } catch {
    return { ok: false, reasons: ["manifest.json 无法解析"], manifest: null };
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) reasons.push(`不支持的备份格式版本 ${manifest.formatVersion}`);
  for (const file of manifest.files) {
    const path = resolve(directory, file.name);
    if (!existsSync(path)) { reasons.push(`缺少文件 ${file.name}`); continue; }
    if (statSync(path).size !== file.sizeBytes) reasons.push(`文件 ${file.name} 长度不符`);
    if (sha256File(path) !== file.sha256) reasons.push(`文件 ${file.name} 哈希不符`);
  }
  const databasePath = resolve(directory, DATABASE_FILE_NAME);
  if (!existsSync(databasePath)) {
    reasons.push("缺少数据库文件");
  } else {
    let probe: Database.Database | undefined;
    try {
      probe = new Database(databasePath, { readonly: true, fileMustExist: true });
      const check = probe.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      if (check?.quick_check !== "ok") reasons.push("数据库完整性检查失败");
      const applied = probe.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number } | undefined;
      if (!applied || applied.count !== manifest.schemaVersion) reasons.push("迁移版本与清单不一致");
    } catch {
      reasons.push("数据库无法打开");
    } finally {
      probe?.close();
    }
  }
  if (expectedSigningKeyId && manifest.signingKeyId !== expectedSigningKeyId) reasons.push("签名身份与当前服务端不一致");
  return { ok: reasons.length === 0, reasons, manifest };
}

export function listBackups(): { directory: string; name: string; verification: BackupVerification }[] {
  const root = backupsDirectory();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = resolve(root, entry.name);
      return { directory, name: entry.name, verification: verifyBackup(directory) };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * 离线恢复：校验备份后，先把当前文件移入 stash 目录，再原子替换。
 * 必须在控制平面进程停止、数据库连接关闭后由操作者执行。
 */
export function restoreBackup(directory: string, options: { dataDir: string; now?: string }): { restored: string[]; stashDir: string } {
  const verification = verifyBackup(directory);
  if (!verification.ok || !verification.manifest)
    throw new Error(`备份校验失败：${verification.reasons.join("；")}`);
  mkdirSync(options.dataDir, { recursive: true });
  const stashDir = resolve(options.dataDir, `.restore-stash-${(options.now ?? new Date().toISOString()).replace(/[:.]/g, "-")}`);
  mkdirSync(stashDir, { recursive: true });
  const restored: string[] = [];
  for (const file of verification.manifest.files) {
    const source = resolve(directory, file.name);
    const target = resolve(options.dataDir, file.name);
    if (existsSync(target)) renameSync(target, resolve(stashDir, file.name));
    copyFileSync(source, target);
    restored.push(file.name);
  }
  return { restored, stashDir };
}