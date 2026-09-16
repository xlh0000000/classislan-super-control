import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

type HttpError = Error & { statusCode?: number; data?: unknown };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string; data?: unknown }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data });

import { migrate } from "../server/migrations";
import { pollSchema } from "../shared/schemas";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import type { AuthenticatedDeviceRequest } from "../server/utils/device-auth";
import { deviceScopeFilter } from "../server/utils/scope";
import {
  CRASH_PER_DEVICE_LIMIT,
  clearCrashReports,
  crashFingerprint,
  crashGroups,
  crashSeries,
  crashStats,
  deviceCrashSummary,
  listCrashReports,
  normalizeStackTrace,
  pruneCrashReports,
  recordCrashReports,
  type CrashReportInput,
} from "../server/utils/crash-reports";

const NOW = "2026-09-11T00:00:00.000Z";
const DEVICE_ID = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";
const OTHER_DEVICE = "7f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
/** 全校范围：不按组织过滤。 */
const SCHOOL_WIDE = { sql: "1=1", params: [] as string[] };

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedOrgNode(db: Database.Database, id: string, parentId: string | null, name: string, path: string) {
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,0,?)")
    .run(id, parentId, name, path, NOW);
}

function seedDevice(db: Database.Database, id = DEVICE_ID, orgNodeId: string | null = null) {
  db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, `设备-${id}`, orgNodeId, "{}", `thumb-${id}`, NOW);
}

function auth(sequence: number, requestHash: string, lastSequence: number): AuthenticatedDeviceRequest {
  return { rawBody: "{}", deviceId: DEVICE_ID, sequence, timestampUtc: NOW, requestHash, deviceLastSequence: lastSequence };
}

function input(sequence: number, extra: Partial<DevicePollInput> = {}): DevicePollInput {
  return {
    deviceId: DEVICE_ID, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
    driftCount: 0, acknowledgements: [], crashes: [], ...extra,
  };
}

function countingSigner() {
  let calls = 0;
  return {
    signer: (body: string) => ({ keyId: "test-key", signature: `sig-${++calls}-${body.length}` }),
    calls: () => calls,
  };
}

function crash(overrides: Partial<CrashReportInput> = {}): CrashReportInput {
  return {
    id: "4c1a9f0b7d2e4a5c8f3b1d6e9a0c2f47",
    occurredAtUtc: NOW,
    kind: "unhandled-exception",
    exceptionType: "System.NullReferenceException",
    message: "Object reference not set to an instance of an object.",
    stackTrace: "   at App.MainWindow.OnLoaded(Object sender, RoutedEventArgs e)\n   at Avalonia.RoutedEvent.InvokeHandler(Object sender, RoutedEventArgs e)",
    threadName: "UI Thread",
    appVersion: "2.1.1.1",
    pluginVersion: "0.1.0",
    platform: "Windows/x64",
    ...overrides,
  };
}

function countReports(db: Database.Database) {
  return (db.prepare("SELECT COUNT(*) count FROM crash_reports").get() as { count: number }).count;
}

function crashAuditActions(db: Database.Database) {
  return (db.prepare("SELECT action FROM audit_events WHERE action LIKE 'device.crash%' ORDER BY sequence").all() as { action: string }[])
    .map((row) => row.action);
}

/** 直接落库一批报告：绕开轮询，用于构造统计/清理所需的数据形状。 */
function seedReports(db: Database.Database, deviceId: string, reports: CrashReportInput[], orgNodeId: string | null = null) {
  return db.transaction(() => recordCrashReports(db, { deviceId, orgNodeId }, reports, new Date().toISOString())).immediate();
}

describe("device crash reports", () => {
  it("轮询随带上报入库，并按客户端主键幂等去重", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    const first = crash();
    const second = crash({ id: "8d5b2c4e6f7a9b0c1d2e3f4051627384", exceptionType: "System.InvalidOperationException" });

    processDevicePoll(db, auth(1, "hash-1", 0), input(1, { crashes: [first, second] }), NOW, signer);
    expect(countReports(db)).toBe(2);
    expect(crashAuditActions(db)).toEqual(["device.crash.report"]);

    // 回执未被确认导致的整批重传：主键命中，不重复入库、也不重复记审计。
    processDevicePoll(db, auth(2, "hash-2", 1), input(2, { crashes: [first, second] }), NOW, signer);
    expect(countReports(db)).toBe(2);
    expect(crashAuditActions(db)).toEqual(["device.crash.report"]);

    // 新报告继续入库并再记一条审计。
    processDevicePoll(db, auth(3, "hash-3", 2), input(3, {
      crashes: [crash({ id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", kind: "ui-thread" })],
    }), NOW, signer);
    expect(countReports(db)).toBe(3);
    expect(crashAuditActions(db)).toEqual(["device.crash.report", "device.crash.report"]);
    db.close();
  });

  it("坏报告降级容忍，绝不让整轮轮询因上报失败", () => {
    const parsed = pollSchema.safeParse({
      deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
      platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, driftCount: 0, acknowledgements: [],
      // 未知的 kind 与空异常类型都属于“坏报告”，应被折叠到兜底值而不是整轮 400。
      crashes: [crash({ kind: "totally-unknown" as never, exceptionType: "" })],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.crashes[0]?.kind).toBe("unhandled-exception");
      expect(parsed.data.crashes[0]?.exceptionType).toBe("UnknownException");
    }
    // 超过单轮上限属于形状错误：插件按 20 条分批发送，这里确认服务端确实会拒绝超限。
    expect(pollSchema.safeParse({
      deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
      platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, driftCount: 0, acknowledgements: [],
      crashes: Array.from({ length: 21 }, (_, index) => crash({ id: `overflow-${String(index).padStart(8, "0")}` })),
    }).success).toBe(false);
  });

  it("同一处崩溃在不同构建归到同一指纹，异常类型不同则分开", () => {
    const build = "   at App.MainWindow.OnLoaded(Object sender, RoutedEventArgs e)\n   at Avalonia.RoutedEvent.InvokeHandler(Object sender, RoutedEventArgs e)\n   at App.Shell.Run()\n   at App.Program.Main(String[] args)\n   at System.RuntimeMethodHandle.Invoke()";
    const rebuilt = "   at App.MainWindow.OnLoaded(Object sender, RoutedEventArgs e) in C:\\agent\\src\\MainWindow.cs:line 42\n   at Avalonia.RoutedEvent.InvokeHandler(Object sender, RoutedEventArgs e) in C:\\agent\\src\\RoutedEvent.cs:line 1180\n   at App.Shell.Run() in C:\\agent\\src\\Shell.cs:line 7\n   at App.Program.Main(String[] args) in C:\\agent\\src\\Program.cs:line 9\n   at System.RuntimeMethodHandle.Invoke() in C:\\agent\\src\\Invoke.cs:line 3";
    // 原始堆栈不同（帧里带源文件与行号），归一化后相同：这才有跨构建归组的可能。
    expect(build).not.toBe(rebuilt);
    expect(normalizeStackTrace(build)).toEqual(normalizeStackTrace(rebuilt));
    expect(crashFingerprint("System.NullReferenceException", build))
      .toBe(crashFingerprint("System.NullReferenceException", rebuilt));
    // 异常类型参与指纹：类型不同即不同分组。
    expect(crashFingerprint("System.ArgumentException", build))
      .not.toBe(crashFingerprint("System.NullReferenceException", build));
    // 前 4 帧之外的差异不影响归组。
    expect(crashFingerprint("System.NullReferenceException", `${build}\n   at Other.Frame($0x7ff)`))
      .toBe(crashFingerprint("System.NullReferenceException", build));
  });

  it("按指纹分组并统计设备、次数与版本分布", () => {
    const db = createDb();
    seedDevice(db, DEVICE_ID);
    seedDevice(db, OTHER_DEVICE);
    seedReports(db, DEVICE_ID, [
      crash(),
      crash({ id: "8d5b2c4e6f7a9b0c1d2e3f4051627384", threadName: "ThreadPool" }),
    ]);
    seedReports(db, OTHER_DEVICE, [crash({ id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", appVersion: "2.1.0.1" })]);

    const groups = crashGroups(db, { scope: SCHOOL_WIDE, days: 14 });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      exceptionType: "System.NullReferenceException", kind: "unhandled-exception", count: 3, deviceCount: 2,
    });
    expect(groups[0]?.appVersions.sort()).toEqual(["2.1.0.1", "2.1.1.1"]);
    expect(groups[0]?.fingerprint).toHaveLength(40);

    const detail = listCrashReports(db, { scope: SCHOOL_WIDE, days: 14, deviceId: OTHER_DEVICE });
    expect(detail).toHaveLength(1);
    expect(detail[0]?.deviceName).toBe(`设备-${OTHER_DEVICE}`);
    expect(detail[0]?.stackTrace).toContain("Avalonia.RoutedEvent");
    db.close();
  });

  it("统计总量、近 24 小时与涉及设备数", () => {
    const db = createDb();
    seedDevice(db, DEVICE_ID);
    seedDevice(db, OTHER_DEVICE);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    seedReports(db, DEVICE_ID, [
      crash({ id: "recent-report-0001", occurredAtUtc: hourAgo }),
      crash({ id: "older-report-00001", occurredAtUtc: threeDaysAgo }),
    ]);
    seedReports(db, OTHER_DEVICE, [crash({ id: "recent-report-0002", occurredAtUtc: hourAgo })]);

    const stats = crashStats(db, { scope: SCHOOL_WIDE, days: 14 });
    expect(stats.total).toBe(3);
    expect(stats.last24h).toBe(2);
    expect(stats.last7d).toBe(3);
    expect(stats.devices).toBe(2);
    expect(stats.latestAt).toBe(hourAgo);
    expect(stats.topDevices.map((row) => row.deviceId)).toEqual([DEVICE_ID, OTHER_DEVICE]);
    expect(stats.topDevices[0]).toMatchObject({ count: 2, deviceName: `设备-${DEVICE_ID}` });

    // 时间窗口外的报告不计入。
    const narrow = crashStats(db, { scope: SCHOOL_WIDE, days: 1 });
    expect(narrow.total).toBe(2);
    expect(narrow.last7d).toBe(2);
    db.close();
  });

  it("逐日曲线按调用方时区归自然日", () => {
    const tz = 480; // 东八区
    const localNow = Date.now() + tz * 60_000;
    const localMidnight = Math.floor(localNow / 86_400_000) * 86_400_000;
    const localDay = new Date(localMidnight).toISOString().slice(0, 10);
    // “当地 00:30”在 UTC 上仍是前一天：同一份报告在东八区归到当天，按 UTC 归到前一天。
    const utcIso = new Date(localMidnight + 30 * 60_000 - tz * 60_000).toISOString();
    expect(utcIso.slice(0, 10)).not.toBe(localDay);

    const local = crashSeries([utcIso], 2, -tz);
    expect(local.at(-1)?.day).toBe(localDay);
    expect(local.at(-1)?.count).toBe(1);

    const utc = crashSeries([utcIso], 2, 0);
    const utcRow = utc.find((point) => point.day === utcIso.slice(0, 10));
    expect(utcRow?.count).toBe(1);
    // 同一条报告在两种归组下落在不同的“天”上。
    expect(utcRow?.day).not.toBe(local.at(-1)?.day);
  });

  it("每台设备只保留最近若干条，多出的按时间从旧到新丢弃", () => {
    const db = createDb();
    seedDevice(db, DEVICE_ID);
    const start = Date.parse(NOW);
    const reports = Array.from({ length: CRASH_PER_DEVICE_LIMIT + 5 }, (_, index) => crash({
      id: `trim-${String(index).padStart(8, "0")}`,
      occurredAtUtc: new Date(start + index * 1000).toISOString(),
    }));
    const ingested = seedReports(db, DEVICE_ID, reports);
    expect(ingested.accepted).toBe(CRASH_PER_DEVICE_LIMIT + 5);
    expect(ingested.trimmed).toBe(5);
    expect(countReports(db)).toBe(CRASH_PER_DEVICE_LIMIT);

    const kept = listCrashReports(db, { scope: SCHOOL_WIDE, days: 365, limit: 500 });
    expect(kept[0]?.id).toBe(`trim-${String(CRASH_PER_DEVICE_LIMIT + 4).padStart(8, "0")}`);
    expect(kept.at(-1)?.id).toBe("trim-00000005");
    db.close();
  });

  it("定期清理只保留保留期内的报告", () => {
    const db = createDb();
    seedDevice(db, DEVICE_ID);
    seedReports(db, DEVICE_ID, [
      crash({ id: "stale-report-0001", occurredAtUtc: new Date(Date.now() - 100 * 86_400_000).toISOString() }),
      crash({ id: "fresh-report-0001", occurredAtUtc: new Date(Date.now() - 3_600_000).toISOString() }),
    ]);
    expect(countReports(db)).toBe(2);
    expect(pruneCrashReports(db, 90)).toBe(1);
    expect(listCrashReports(db, { scope: SCHOOL_WIDE, days: 365 }).map((row) => row.id)).toEqual(["fresh-report-0001"]);
    db.close();
  });

  it("账号组织范围限制统计、明细与清除", () => {
    const db = createDb();
    seedOrgNode(db, "a", null, "东校区", "/a");
    seedOrgNode(db, "b", "a", "高一", "/a/b");
    seedOrgNode(db, "c", null, "西校区", "/c");
    seedDevice(db, DEVICE_ID, "b");
    seedDevice(db, OTHER_DEVICE, "c");
    seedReports(db, DEVICE_ID, [crash()], "b");
    seedReports(db, OTHER_DEVICE, [crash({ id: "8d5b2c4e6f7a9b0c1d2e3f4051627384" })], "c");

    const eastScope = deviceScopeFilter(db, { id: "east", role: "operator", scopeOrgNodeId: "a" }, "cr");
    expect(crashStats(db, { scope: eastScope, days: 14 }).total).toBe(1);
    expect(crashStats(db, { scope: eastScope, days: 14 }).devices).toBe(1);
    expect(listCrashReports(db, { scope: eastScope, days: 14 }).map((row) => row.deviceId)).toEqual([DEVICE_ID]);
    expect(crashGroups(db, { scope: eastScope, days: 14 })[0]?.deviceCount).toBe(1);

    // 越权清除为 0 条：西校区的记录不受影响。
    const westFingerprint = crashFingerprint("System.NullReferenceException", crash().stackTrace);
    const before = countReports(db);
    expect(clearCrashReports(db, { scope: eastScope, fingerprint: westFingerprint, deviceId: OTHER_DEVICE })).toBe(0);
    expect(countReports(db)).toBe(before);
    // 范围内的清除按指纹生效。
    expect(clearCrashReports(db, { scope: eastScope, fingerprint: westFingerprint })).toBe(1);
    expect(listCrashReports(db, { scope: SCHOOL_WIDE, days: 14 }).map((row) => row.deviceId)).toEqual([OTHER_DEVICE]);
    // 全校范围账号（owner）不受组织限制。
    expect(crashStats(db, { scope: deviceScopeFilter(db, { id: "owner", role: "owner" }, "cr"), days: 14 }).total).toBe(1);
    expect(clearCrashReports(db, { scope: SCHOOL_WIDE })).toBe(1);
    expect(countReports(db)).toBe(0);
    db.close();
  });

  it("设备详情摘要给出总量、近 7 天与最近一次", () => {
    const db = createDb();
    seedDevice(db, DEVICE_ID);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    seedReports(db, DEVICE_ID, [
      crash({ id: "summary-report-1", occurredAtUtc: hourAgo }),
      crash({ id: "summary-report-2", occurredAtUtc: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
    ]);
    expect(deviceCrashSummary(db, DEVICE_ID)).toEqual({ total: 2, last7d: 1, lastAt: hourAgo });
    expect(deviceCrashSummary(db, OTHER_DEVICE)).toEqual({ total: 0, last7d: 0, lastAt: null });
    db.close();
  });
});