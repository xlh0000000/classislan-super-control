import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate } from "../migrations";

let database: Database.Database | undefined;

export function databasePath() {
  const config = useRuntimeConfig();
  return resolve(process.env.CLASSISLAND_CONTROL_DATA_DIR || config.dataDir, "classisland-control.db");
}

export function useDatabase() {
  if (database) return database;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  // 迁移必须在局部连接上完成；只有全部成功后才发布全局单例。
  // 迁移或 PRAGMA 失败时关闭并丢弃该连接，避免后续请求拿到半初始化连接。
  const candidate = new Database(path);
  try {
    candidate.pragma("journal_mode = WAL");
    candidate.pragma("foreign_keys = ON");
    candidate.pragma("busy_timeout = 5000");
    candidate.pragma("synchronous = NORMAL");
    migrate(candidate);
  } catch (error) {
    try { candidate.close(); } catch { /* 已关闭或无连接 */ }
    throw error;
  }
  database = candidate;
  return database;
}

export function closeDatabase() {
  database?.close();
  database = undefined;
}

export type DatabaseProbe =
  | { ok: true; schemaVersion: number }
  | {
      ok: false;
      reason: "database_missing" | "database_unreadable" | "integrity_check_failed" | "schema_not_migrated";
      schemaVersion: number;
    };

/**
 * 只读探针：打开已存在的数据库文件，校验完整性与迁移状态。
 * 不创建文件、不执行迁移，避免健康检查凭空造出“健康”的空库。
 */
export function probeDatabase(): DatabaseProbe {
  const path = databasePath();
  if (!existsSync(path)) return { ok: false, reason: "database_missing", schemaVersion: 0 };
  let probe: Database.Database | undefined;
  try {
    probe = new Database(path, { readonly: true, fileMustExist: true });
    const check = probe.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") return { ok: false, reason: "integrity_check_failed", schemaVersion: 0 };
    const hasMigrations = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (!hasMigrations) return { ok: false, reason: "schema_not_migrated", schemaVersion: 0 };
    const applied = probe.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number } | undefined;
    if (!applied || applied.count < 1) return { ok: false, reason: "schema_not_migrated", schemaVersion: 0 };
    return { ok: true, schemaVersion: applied.count };
  } catch {
    return { ok: false, reason: "database_unreadable", schemaVersion: 0 };
  } finally {
    probe?.close();
  }
}

export function nowIso() { return new Date().toISOString(); }