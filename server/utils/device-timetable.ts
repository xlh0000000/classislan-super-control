import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createError } from "h3";
import { normalizeConfigurationDocument } from "../../shared/schemas";
import { appendAuditWithin, canonicalJson, sha256 } from "./security";
import { nowIso } from "./database";

// 贡献者：威廉（课表上传存档模块：摘要校验 / 覆盖写入 / 读取）

export type DeviceTimetableRow = {
  deviceId: string;
  digest: string;
  snapshot: string;
  subjectsCount: number;
  timeLayoutsCount: number;
  classPlansCount: number;
  classPlanGroupsCount: number;
  uploadedAt: string;
};

export type DeviceTimetableInput = {
  digest?: string;
  timetable: Record<string, unknown>;
};

/** 与插件端算法一致：RFC 8785（JCS）规范形式 → SHA-256 十六进制小写。 */
export function computeTimetableDigest(snapshot: unknown): string {
  return sha256(canonicalJson(snapshot));
}

function countOf(dict: unknown): number {
  if (dict && typeof dict === "object" && !Array.isArray(dict)) return Object.keys(dict as Record<string, unknown>).length;
  return 0;
}

export function readDeviceTimetable(db: Database.Database, deviceId: string): DeviceTimetableRow | undefined {
  return db
    .prepare(`SELECT device_id deviceId,digest,snapshot,subjects_count subjectsCount,time_layouts_count timeLayoutsCount,
      class_plans_count classPlansCount,class_plan_groups_count classPlanGroupsCount,uploaded_at uploadedAt
      FROM device_timetables WHERE device_id=?`)
    .get(deviceId) as DeviceTimetableRow | undefined;
}

/** 设备只报摘要时，据此判断服务端档案是否已与之对齐（未对齐则要求重传全量）。 */
export function timetableDigestMatches(db: Database.Database, deviceId: string, digest: string): boolean {
  return readDeviceTimetable(db, deviceId)?.digest === digest;
}

/**
 * 在轮询事务内覆盖写入设备课表档案。
 * 防篡改：内容必须与声称的摘要一致（JCS + SHA-256），不一致直接拒绝存档，
 * 让客户端重传，避免损坏或中间人改写的快照污染服务端。
 * 摘要变化（首次上传或内容更新）时追加审计事件。
 */
export function upsertDeviceTimetable(
  db: Database.Database,
  deviceId: string,
  input: DeviceTimetableInput,
  seenAt: string,
) {
  const digest = computeTimetableDigest(input.timetable);
  if (input.digest !== undefined && input.digest !== digest)
    throw createError({ statusCode: 409, message: "课表摘要与内容不符，已拒绝存档。" });
  const existing = readDeviceTimetable(db, deviceId);
  const subjectsCount = countOf(input.timetable.subjects);
  const timeLayoutsCount = countOf(input.timetable.timeLayouts);
  const classPlansCount = countOf(input.timetable.classPlans);
  const classPlanGroupsCount = countOf(input.timetable.classPlanGroups);
  db.prepare(`INSERT INTO device_timetables (device_id,digest,snapshot,subjects_count,time_layouts_count,class_plans_count,class_plan_groups_count,uploaded_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET digest=excluded.digest,snapshot=excluded.snapshot,
      subjects_count=excluded.subjects_count,time_layouts_count=excluded.time_layouts_count,
      class_plans_count=excluded.class_plans_count,class_plan_groups_count=excluded.class_plan_groups_count,
      uploaded_at=excluded.uploaded_at`)
    .run(deviceId, digest, JSON.stringify(input.timetable), subjectsCount, timeLayoutsCount, classPlansCount, classPlanGroupsCount, seenAt);
  if (!existing || existing.digest !== digest)
    appendAuditWithin(db, {
      actorType: "device", actorId: deviceId, action: "timetable.upload", targetType: "device", targetId: deviceId,
      summary: `设备上传课表档案（${subjectsCount} 科目 · ${timeLayoutsCount} 时间表 · ${classPlansCount} 课表 · ${classPlanGroupsCount} 群）`,
      details: { digest },
    });
  return { digest, uploadedAt: seenAt };
}

export type AdoptTimetableOptions = {
  configurationId?: string;
  name?: string;
};

/**
 * 采纳为配置（贡献者：威廉）：把设备上报的课表档案快照写入配置库，作为一条 kind="profile"
 * 的配置（新建或向既有配置追加新修订），之后可经策略引用 { "$config": id } 下发给其他设备。
 */
export function adoptTimetableAsConfiguration(
  db: Database.Database,
  actor: { id: string },
  deviceId: string,
  opts: AdoptTimetableOptions = {},
) {
  const row = readDeviceTimetable(db, deviceId);
  if (!row) throw createError({ statusCode: 409, message: "该设备尚未上传课表档案。" });
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(row.snapshot) as Record<string, unknown>;
  } catch {
    throw createError({ statusCode: 500, message: "设备课表档案无法解析。" });
  }
  const deviceName = (db.prepare("SELECT name FROM devices WHERE id=?").get(deviceId) as { name: string } | undefined)?.name ?? deviceId;
  const name = opts.name ?? `${deviceName} 的课表档案`;
  // 与 configurations.post.ts 相同的版本化结构校验与修订写入路径。
  const document = normalizeConfigurationDocument("profile", { profile: snapshot });
  if (JSON.stringify(document).length > 2_000_000)
    throw createError({ statusCode: 413, message: "课表档案超过大小限制。" });

  const configurationId = opts.configurationId ?? randomUUID();
  const save = db.transaction(() => {
    const existing = db.prepare("SELECT id,current_revision_id currentRevisionId FROM configurations WHERE id=?").get(configurationId) as { id: string; currentRevisionId: string | null } | undefined;
    if (!existing) {
      db.prepare("INSERT INTO configurations (id,kind,name,updated_at) VALUES (?,?,?,?)")
        .run(configurationId, "profile", name, nowIso());
    }
    const current = db.prepare("SELECT COALESCE(MAX(revision),0) value FROM configuration_revisions WHERE configuration_id=?").get(configurationId) as { value: number };
    const revision = current.value + 1;
    const revisionId = randomUUID();
    const serialized = JSON.stringify(document);
    const createdAt = nowIso();
    db.prepare(`INSERT INTO configuration_revisions
      (id,configuration_id,kind,name,revision,document,document_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(revisionId, configurationId, "profile", name, revision, serialized, sha256(serialized), actor.id, createdAt);
    db.prepare("UPDATE configurations SET current_revision_id=?,kind=?,name=?,updated_at=? WHERE id=?").run(revisionId, "profile", name, createdAt, configurationId);
    appendAuditWithin(db, {
      actorType: "user", actorId: actor.id, action: "configuration.adopt-from-device",
      targetType: "device", targetId: deviceId,
      summary: `采纳设备「${deviceName}」的课表档案为配置「${name}」R${revision}`,
      details: { configurationId, revision, digest: row.digest, name },
    });
    return { id: revisionId, configurationId, revision, schemaVersion: document.schemaVersion, documentHash: sha256(serialized), digest: row.digest, name };
  });
  return save();
}
