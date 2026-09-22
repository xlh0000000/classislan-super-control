import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { nowIso } from "./database";
import { appendAuditWithin, sha256 } from "./security";
import { calculateJwkThumbprint } from "./device-auth";
import { publishEnrollmentPreset, type EnrollmentPresetSource } from "./policy";

/** 携带 HTTP 状态码的注册失败，供端点直接映射，避免 util 依赖 Nitro 全局。 */
export class EnrollmentError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "EnrollmentError";
  }
}

export type EnrollmentInput = {
  token: string;
  name: string;
  publicKeyJwk: import("node:crypto").JsonWebKey;
  keyThumbprint?: string;
  pluginVersion: string;
  appVersion: string;
  platform: string;
};

/** 注册结果：replayed 表示命中之前的设备；presetRevision 为本次写入的预配置策略修订号。 */
export type EnrollmentOutcome = { deviceId: string; replayed: boolean; presetRevision: number | null };

type ReplayRow = { deviceId: string; revokedAt: string | null };
type TokenRow = { id: string; kind: string; orgNodeId: string | null; maxUses: number; useCount: number; createdBy: string | null; policyRevisionId: string | null };
type PresetSourceRow = { revision: number; name: string; document: string; locks: string | null };

/**
 * 幂等设备接入。
 *
 * 客户端在发起注册请求前先持久化密钥对，因此响应丢失后的重试会带着同一公钥与同一凭据回来。
 * 此时必须返回既有设备身份，而不是再次消费令牌或创建孤儿设备。实现顺序为：
 * 1. 先按 (公钥指纹, 原始凭据) 查既有设备，命中即直接返回，不再触碰令牌使用次数；
 * 2. 未命中时才在单个事务内消费令牌并创建设备，令牌耗尽或并发冲突都整体回滚。
 * 创建设备的同一事务里套用凭据的组织与标签绑定；凭据若绑定了策略修订，
 * 就以那份修订为底稿写成该设备的预置策略。预置只在首次成功时落库，重放不会重复下发。
 */
export function enrollDevice(db: Database.Database, input: EnrollmentInput, now = nowIso()): EnrollmentOutcome {
  const thumbprint = calculateJwkThumbprint(input.publicKeyJwk);
  if (input.keyThumbprint && input.keyThumbprint !== thumbprint)
    throw new EnrollmentError(400, "设备公钥指纹不匹配。");

  const tokenHash = sha256(input.token);
  const replay = db.prepare(`SELECT d.id deviceId, t.revoked_at revokedAt
    FROM devices d JOIN enrollment_tokens t ON t.id = d.enrollment_token_id
    WHERE d.key_thumbprint = ? AND t.token_hash = ?`).get(thumbprint, tokenHash) as ReplayRow | undefined;
  if (replay) {
    if (replay.revokedAt) throw new EnrollmentError(401, "接入凭据已吊销。");
    return { deviceId: replay.deviceId, replayed: true, presetRevision: null };
  }

  const tokenRow = db.prepare(`SELECT id,kind,org_node_id orgNodeId,max_uses maxUses,use_count useCount,created_by createdBy,policy_revision_id policyRevisionId
    FROM enrollment_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(tokenHash, now) as TokenRow | undefined;
  if (!tokenRow || tokenRow.useCount >= tokenRow.maxUses)
    throw new EnrollmentError(401, "接入凭据无效、已过期或已用尽。");

  const id = randomUUID();
  const register = db.transaction(() => {
    const consumed = db.prepare(`UPDATE enrollment_tokens SET use_count=use_count+1
      WHERE id=? AND use_count<max_uses AND revoked_at IS NULL AND expires_at>?`).run(tokenRow.id, now);
    if (consumed.changes !== 1) throw new Error("Enrollment token has been consumed");
    db.prepare(`INSERT INTO devices
      (id,name,org_node_id,public_key_jwk,key_thumbprint,plugin_version,app_version,platform,enrollment_token_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.name, tokenRow.orgNodeId, JSON.stringify(input.publicKeyJwk), thumbprint, input.pluginVersion, input.appVersion, input.platform, tokenRow.id, now);
    const addTag = db.prepare("INSERT OR IGNORE INTO device_tags (device_id,tag_id) VALUES (?,?)");
    const tokenTags = db.prepare("SELECT tag_id tagId FROM enrollment_token_tags WHERE enrollment_token_id=?").all(tokenRow.id) as { tagId: string }[];
    for (const { tagId } of tokenTags) addTag.run(id, tagId);
    // 接入凭据绑定的策略修订是新设备策略的底稿；锁跟着一起过来，之后设备级仍可单独改。
    // 修订行不会被删（旧修订只作历史），取不到就当没绑定，不让一次注册整体回滚成 409。
    const sourceRow = tokenRow.policyRevisionId
      ? db.prepare(`SELECT revision,name,document,(SELECT pa.locks FROM policy_assignments pa
          WHERE pa.policy_revision_id=pr.id AND pa.superseded_at IS NULL LIMIT 1) locks
          FROM policy_revisions pr WHERE pr.id=?`).get(tokenRow.policyRevisionId) as PresetSourceRow | undefined
      : undefined;
    const presetSource: EnrollmentPresetSource | null = sourceRow
      ? { revision: sourceRow.revision, name: sourceRow.name, document: JSON.parse(sourceRow.document) as Record<string, unknown>, locks: JSON.parse(sourceRow.locks ?? "[]") as string[] }
      : null;
    const presetRevision = presetSource
      ? publishEnrollmentPreset(db, id, presetSource, tokenRow.createdBy, now)
      : null;
    appendAuditWithin(db, { actorType: "device", actorId: id, action: "device.enroll", targetType: "device", targetId: id, summary: `设备 ${input.name} 自动激活`, details: { method: tokenRow.kind, platform: input.platform, presetRevision } });
    return presetRevision;
  });
  let presetRevision: number | null;
  try { presetRevision = register(); } catch { throw new EnrollmentError(409, "设备身份已注册或凭据发生并发冲突。"); }
  return { deviceId: id, replayed: false, presetRevision };
}