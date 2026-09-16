import type Database from "better-sqlite3";
import type { z } from "zod";
import type { crashReportSchema } from "../../shared/schemas";
import { nowIso } from "./database";
import { sha256 } from "./security";

export type CrashReportInput = z.infer<typeof crashReportSchema>;
export type ScopeFilter = { sql: string; params: string[] };

/** 崩溃查询条件：作用域由调用方给出的 SQL 片段限定，其余为可选筛选。 */
export type CrashQuery = {
  scope: ScopeFilter;
  /** 只统计最近 N 天；缺省表示不限时间。 */
  days?: number | null;
  deviceId?: string | null;
  kind?: string | null;
  fingerprint?: string | null;
};

/** 每台设备保留的崩溃条数上限，避免单机长期故障把表撑爆。 */
export const CRASH_PER_DEVICE_LIMIT = 200;
/** 全局保留天数，由后台调度器定期清理。 */
export const CRASH_RETENTION_DAYS = 90;

export type CrashStats = {
  total: number;
  last24h: number;
  last7d: number;
  devices: number;
  latestAt: string | null;
  series: { day: string; count: number }[];
  topDevices: { deviceId: string; deviceName: string; count: number; lastSeenAt: string }[];
};

export type CrashGroup = {
  fingerprint: string;
  exceptionType: string;
  kind: string;
  count: number;
  deviceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  appVersions: string[];
};

export type CrashReportRow = {
  id: string;
  deviceId: string;
  deviceName: string;
  occurredAt: string;
  kind: string;
  exceptionType: string;
  message: string;
  stackTrace: string;
  appVersion: string;
  pluginVersion: string;
  platform: string;
  threadName: string;
};

/**
 * 归一化栈帧：抹掉行号、地址、GUID 与源文件路径等易变部分，只保留“调用形状”，
 * 使同一处崩溃在不同构建、不同设备上归到同一个指纹。
 */
export function normalizeStackTrace(stackTrace: string) {
  return String(stackTrace ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        // .NET 栈帧形如 "at Ns.Type.Method(String x) in C:\path\File.cs:line 42"：
        // 去掉带行号的源文件位置，只比较调用方。
        .replace(/\s+in\s+.*$/i, "")
        .replace(/0x[0-9a-f]+/gi, "0xX")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
        .replace(/\b\d+\b/g, "N")
        .replace(/\s+/g, " "),
    )
    .filter((line) => line.length > 0);
}

/** 崩溃指纹：异常类型 + 归一化后的前若干帧。 */
export function crashFingerprint(exceptionType: string, stackTrace: string) {
  const frames = normalizeStackTrace(stackTrace).slice(0, 4);
  return sha256([exceptionType.trim().toLowerCase(), ...frames].join("\n")).slice(0, 40);
}

/** 把上报时间规整到可信区间：解析失败或来自未来（超过 5 分钟）时回退到接收时刻。 */
function sanitizeOccurredAt(occurredAtUtc: string, receivedAt: string) {
  const parsed = Date.parse(occurredAtUtc);
  if (!Number.isFinite(parsed)) return receivedAt;
  if (parsed > Date.parse(receivedAt) + 5 * 60_000) return receivedAt;
  return new Date(parsed).toISOString();
}

/**
 * 落库一批崩溃上报（调用方必须已处于 IMMEDIATE 事务中）。
 * 主键是客户端生成的一次性 ID，`INSERT OR IGNORE` 让重传天然幂等。
 */
export function recordCrashReports(
  db: Database.Database,
  context: { deviceId: string; orgNodeId: string | null },
  reports: CrashReportInput[],
  receivedAt = nowIso(),
) {
  if (reports.length === 0) return { accepted: 0, trimmed: 0 };
  const insert = db.prepare(`INSERT OR IGNORE INTO crash_reports
    (id,device_id,org_node_id,occurred_at,received_at,kind,exception_type,message,stack_trace,
     fingerprint,thread_name,app_version,plugin_version,platform)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let accepted = 0;
  for (const report of reports) {
    const result = insert.run(
      report.id,
      context.deviceId,
      context.orgNodeId,
      sanitizeOccurredAt(report.occurredAtUtc, receivedAt),
      receivedAt,
      report.kind,
      report.exceptionType,
      report.message,
      report.stackTrace,
      crashFingerprint(report.exceptionType, report.stackTrace),
      report.threadName,
      report.appVersion,
      report.pluginVersion,
      report.platform,
    );
    if (result.changes > 0) accepted += 1;
  }
  const trimmed = db
    .prepare(`DELETE FROM crash_reports WHERE device_id=? AND id NOT IN (
        SELECT id FROM crash_reports WHERE device_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?)`)
    .run(context.deviceId, context.deviceId, CRASH_PER_DEVICE_LIMIT).changes;
  return { accepted, trimmed };
}

/** 后台清理：只保留最近若干天，控制表体积。 */
export function pruneCrashReports(db: Database.Database, retentionDays = CRASH_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  return db.prepare("DELETE FROM crash_reports WHERE occurred_at < ?").run(cutoff).changes;
}

function cutoffIso(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function buildWhere(query: CrashQuery) {
  const clauses = [query.scope.sql];
  const params: (string | number)[] = [...query.scope.params];
  if (query.deviceId) {
    clauses.push("cr.device_id = ?");
    params.push(query.deviceId);
  }
  if (query.kind) {
    clauses.push("cr.kind = ?");
    params.push(query.kind);
  }
  if (query.fingerprint) {
    clauses.push("cr.fingerprint = ?");
    params.push(query.fingerprint);
  }
  if (query.days) {
    clauses.push("cr.occurred_at >= ?");
    params.push(cutoffIso(query.days));
  }
  return { where: clauses.join(" AND "), params };
}

/** 逐日计数：按调用方时区把 UTC 时间戳归到自然日，避免统计图跨时区错位。 */
export function crashSeries(occurredAtList: string[], days: number, tzOffsetMinutes = 0) {
  const shift = tzOffsetMinutes * 60_000;
  const counts = new Map<string, number>();
  for (const iso of occurredAtList) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    const key = new Date(ms - shift).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const now = Date.now();
  const series: { day: string; count: number }[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = new Date(now - offset * 86_400_000 - shift).toISOString().slice(0, 10);
    series.push({ day: key, count: counts.get(key) ?? 0 });
  }
  return series;
}

/** 概览统计：总量、近 24 小时、近 7 天、受影响设备、逐日曲线与最活跃设备。 */
export function crashStats(
  db: Database.Database,
  query: CrashQuery & { days: number; tzOffsetMinutes?: number },
): CrashStats {
  const { where, params } = buildWhere(query);
  const totals = db
    .prepare(`SELECT COUNT(*) total, COUNT(DISTINCT cr.device_id) devices, MAX(cr.occurred_at) latestAt,
        COALESCE(SUM(CASE WHEN cr.occurred_at >= ? THEN 1 ELSE 0 END),0) last24h,
        COALESCE(SUM(CASE WHEN cr.occurred_at >= ? THEN 1 ELSE 0 END),0) last7d
      FROM crash_reports cr WHERE ${where}`)
    .get(cutoffIso(1), cutoffIso(7), ...params) as {
    total: number;
    devices: number;
    latestAt: string | null;
    last24h: number;
    last7d: number;
  };
  const occurred = db
    .prepare(`SELECT cr.occurred_at occurredAt FROM crash_reports cr WHERE ${where} AND cr.occurred_at >= ?`)
    .all(...params, cutoffIso(query.days)) as { occurredAt: string }[];
  const topDevices = db
    .prepare(`SELECT cr.device_id deviceId, COALESCE(d.name,'已删除设备') deviceName,
        COUNT(*) count, MAX(cr.occurred_at) lastSeenAt
      FROM crash_reports cr LEFT JOIN devices d ON d.id = cr.device_id
      WHERE ${where} GROUP BY cr.device_id ORDER BY count DESC, lastSeenAt DESC LIMIT 5`)
    .all(...params) as CrashStats["topDevices"];
  return {
    ...totals,
    series: crashSeries(
      occurred.map((row) => row.occurredAt),
      query.days,
      query.tzOffsetMinutes ?? 0,
    ),
    topDevices,
  };
}

/** 按指纹归组：同一处崩溃在不同设备上的次数与时间范围。 */
export function crashGroups(db: Database.Database, query: CrashQuery & { limit?: number }): CrashGroup[] {
  const { where, params } = buildWhere(query);
  const rows = db
    .prepare(`SELECT cr.fingerprint fingerprint, MIN(cr.exception_type) exceptionType, MIN(cr.kind) kind,
        COUNT(*) count, COUNT(DISTINCT cr.device_id) deviceCount,
        MIN(cr.occurred_at) firstSeenAt, MAX(cr.occurred_at) lastSeenAt
      FROM crash_reports cr WHERE ${where} GROUP BY cr.fingerprint
      ORDER BY count DESC, lastSeenAt DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(query.limit ?? 50, 1), 200)) as Omit<CrashGroup, "appVersions">[];
  if (rows.length === 0) return [];
  // 版本分布单独查一次，避免在分组里用 GROUP_CONCAT 与聚合混用导致结果不可读。
  const versions = db
    .prepare(`SELECT cr.fingerprint fingerprint, cr.app_version appVersion FROM crash_reports cr
      WHERE ${where} AND cr.app_version <> '' GROUP BY cr.fingerprint, cr.app_version`)
    .all(...params) as { fingerprint: string; appVersion: string }[];
  const byFingerprint = new Map<string, string[]>();
  for (const row of versions) {
    const list = byFingerprint.get(row.fingerprint);
    if (list) list.push(row.appVersion);
    else byFingerprint.set(row.fingerprint, [row.appVersion]);
  }
  return rows.map((row) => ({ ...row, appVersions: byFingerprint.get(row.fingerprint) ?? [] }));
}

/** 明细列表：用于展开某个指纹或某台设备的原始报告。 */
export function listCrashReports(
  db: Database.Database,
  query: CrashQuery & { limit?: number },
): CrashReportRow[] {
  const { where, params } = buildWhere(query);
  return db
    .prepare(`SELECT cr.id id, cr.device_id deviceId, COALESCE(d.name,'已删除设备') deviceName,
        cr.occurred_at occurredAt, cr.kind kind, cr.exception_type exceptionType, cr.message message,
        cr.stack_trace stackTrace, cr.app_version appVersion, cr.plugin_version pluginVersion,
        cr.platform platform, cr.thread_name threadName
      FROM crash_reports cr LEFT JOIN devices d ON d.id = cr.device_id
      WHERE ${where} ORDER BY cr.occurred_at DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(query.limit ?? 100, 1), 500)) as CrashReportRow[];
}

/** 清除匹配的报告（全部 / 某指纹 / 某设备），返回删除条数。 */
export function clearCrashReports(db: Database.Database, query: CrashQuery) {
  const { where, params } = buildWhere(query);
  return db
    .prepare(`DELETE FROM crash_reports WHERE id IN (SELECT cr.id FROM crash_reports cr WHERE ${where})`)
    .run(...params).changes;
}

/** 设备详情用的一行摘要。 */
export function deviceCrashSummary(db: Database.Database, deviceId: string) {
  const row = db
    .prepare(`SELECT COUNT(*) total,
        COALESCE(SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END),0) last7d,
        MAX(occurred_at) lastAt
      FROM crash_reports WHERE device_id=?`)
    .get(cutoffIso(7), deviceId) as { total: number; last7d: number; lastAt: string | null };
  return row;
}