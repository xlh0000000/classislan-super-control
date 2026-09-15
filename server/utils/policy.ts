import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso, useDatabase } from "./database";
import { appendAuditWithin, sha256 } from "./security";
import { assertDeviceInScope, assertOrgNodeInScope, hasSchoolWideScope, type ScopeUser } from "./scope";

export type PolicyLayer = {
  scopeType: "school" | "organization" | "tag" | "device";
  scopeId: string | null;
  priority: number;
  revision: number;
  document: Record<string, unknown>;
  locks: string[];
};

export type ResolvedPolicy = {
  revision: number;
  epoch: number;
  document: Record<string, unknown>;
  locks: Record<string, { scopeType: string; scopeId: string | null }>;
};

/** 策略发布/作用域相关的可映射 HTTP 错误；由路由转换为 createError。 */
export class PolicyError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "PolicyError";
    this.statusCode = statusCode;
  }
}

/** 乐观并发冲突（baseRevision 与当前有效修订不一致）。 */
export class PolicyConflictError extends PolicyError {
  constructor(message: string) {
    super(message, 409);
    this.name = "PolicyConflictError";
  }
}

/** RFC 6901 转义：先 ~1 再 ~0，避免二次转义。 */
export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** 将 RFC 6901 JSON Pointer 规范化；非法指针抛出 RangeError。 */
export function normalizePointer(pointer: string): string {
  if (pointer === "") return "";
  if (!pointer.startsWith("/")) throw new RangeError(`JSON Pointer 必须以 / 开头: ${pointer}`);
  let result = "";
  for (const token of pointer.slice(1).split("/")) {
    let value = token;
    // ~1 必须先于 ~0 解码，防止 "~01" 被错误解码为 "~1"。
    value = value.replaceAll("~1", "/").replaceAll("~0", "~");
    result += `/${value.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  }
  return result;
}

export function normalizePointers(pointers: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pointer of pointers) {
    const normalized = normalizePointer(pointer);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function isLockedPath(pointer: string, locks: string[]): boolean {
  return locks.some((lock) => pointer === lock || pointer.startsWith(`${lock}/`));
}

export function hasLockedDescendant(pointer: string, locks: string[]): boolean {
  return locks.some((lock) => lock.startsWith(`${pointer}/`));
}

function merge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
  locks: string[],
): void {
  for (const [key, value] of Object.entries(source)) {
    const pointer = path === "" ? `/${escapePointerToken(key)}` : `${path}/${escapePointerToken(key)}`;
    if (isLockedPath(pointer, locks)) continue;
    // 下层若整体替换一个已锁定后代的子树，则跳过非对象/数组替换；对象仍递归合并。
    // 数组整体替换同样会删除锁定的后代，因此一并跳过。
    if (hasLockedDescendant(pointer, locks) && (value === null || typeof value !== "object" || Array.isArray(value)))
      continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const current = target[key];
      target[key] = current && typeof current === "object" && !Array.isArray(current) ? current : {};
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>, pointer, locks);
    } else {
      target[key] = value;
    }
  }
}

/**
 * 追加覆盖：把补丁深合并到基线文档上。对象逐层递归，数组与标量整体替换，
 * 因此只有补丁里给出的项会被改写，其余保持基线（该目标已有策略）内容不变。
 */
export function mergePolicyDocuments(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  merge(result, patch, "", []);
  return result;
}

export function resolvePolicy(layers: PolicyLayer[], epoch = 0): ResolvedPolicy {
  const document: Record<string, unknown> = {};
  const locks = new Map<string, { scopeType: PolicyLayer["scopeType"]; scopeId: string | null }>();
  // 合并第 N 层时，只应用已处理的高层锁（0..N-1），当前层锁只约束更低层。
  const activeLocks: string[] = [];
  for (const layer of layers) {
    const normalizedLocks = normalizePointers(layer.locks);
    merge(document, layer.document, "", activeLocks);
    for (const pointer of normalizedLocks) {
      if (!activeLocks.includes(pointer)) activeLocks.push(pointer);
      if (!locks.has(pointer)) locks.set(pointer, { scopeType: layer.scopeType, scopeId: layer.scopeId });
    }
  }
  return {
    revision: Math.max(0, ...layers.map((layer) => layer.revision)),
    epoch,
    document,
    locks: Object.fromEntries(locks),
  };
}

/** 读取当前期望状态 epoch；0 表示尚未发生任何策略激活或成员关系变化。 */
export function desiredStateEpoch(db: Database.Database): number {
  const row = db.prepare("SELECT desired_epoch desiredEpoch FROM policy_state WHERE id=1").get() as { desiredEpoch: number } | undefined;
  return row?.desiredEpoch ?? 0;
}

/**
 * 递增期望状态 epoch。任何策略激活或设备成员关系（组织/标签）变化都必须调用，
 * 使“有效修订回退”（例如去掉标签后 R10 → R1）也能触发设备重同步。
 */
export function bumpDesiredStateEpoch(db: Database.Database, now = nowIso()): number {
  db.prepare(`INSERT INTO policy_state (id,desired_epoch,restore_generation,updated_at) VALUES (1,1,0,?)
    ON CONFLICT(id) DO UPDATE SET desired_epoch=desired_epoch+1, updated_at=excluded.updated_at`).run(now);
  return desiredStateEpoch(db);
}

/** 数据集恢复后强制推进 epoch，避免设备保留恢复前的 applied 状态。 */
export function bumpRestoreGeneration(db: Database.Database, now = nowIso()): number {
  db.prepare(`INSERT INTO policy_state (id,desired_epoch,restore_generation,updated_at) VALUES (1,1,1,?)
    ON CONFLICT(id) DO UPDATE SET desired_epoch=desired_epoch+1, restore_generation=restore_generation+1, updated_at=excluded.updated_at`).run(now);
  return desiredStateEpoch(db);
}

/** 设备已命中的策略层（含名称），顺序与 resolvePolicy 的合并顺序一致。 */
export type DevicePolicyLayer = {
  revisionId: string; revision: number; name: string;
  mode: "replace" | "append";
  scopeType: PolicyLayer["scopeType"]; scopeId: string | null;
  priority: number; locks: string[]; document: Record<string, unknown>;
};

export function policyLayersForDeviceFromDb(db: Database.Database, deviceId: string): DevicePolicyLayer[] {
  const device = db.prepare("SELECT org_node_id orgNodeId FROM devices WHERE id=?").get(deviceId) as { orgNodeId: string | null } | undefined;
  if (!device) return [];
  const tagIds = (db.prepare("SELECT tag_id tagId FROM device_tags WHERE device_id=?").all(deviceId) as { tagId: string }[]).map((row) => row.tagId);
  const orgIds: string[] = [];
  let orgId = device.orgNodeId;
  while (orgId) {
    const row = db.prepare("SELECT id,parent_id parentId FROM org_nodes WHERE id=?").get(orgId) as { id: string; parentId: string | null } | undefined;
    if (!row) break;
    orgIds.unshift(row.id);
    orgId = row.parentId;
  }
  const rows = db.prepare(`SELECT pr.id revisionId,pr.name,pa.scope_type scopeType,pa.scope_id scopeId,pa.priority,pa.locks,pr.revision,pr.document,pr.mode mode
    FROM policy_assignments pa JOIN policy_revisions pr ON pr.id=pa.policy_revision_id
    WHERE pa.superseded_at IS NULL`).all() as {
      revisionId: string; name: string; scopeType: PolicyLayer["scopeType"]; scopeId: string | null;
      priority: number; locks: string; revision: number; document: string; mode: "replace" | "append";
    }[];
  const rank = { school: 0, organization: 1, tag: 2, device: 3 } as const;
  const applicable = rows.filter((row) =>
    row.scopeType === "school"
    || (row.scopeType === "organization" && row.scopeId !== null && orgIds.includes(row.scopeId))
    || (row.scopeType === "tag" && row.scopeId !== null && tagIds.includes(row.scopeId))
    || (row.scopeType === "device" && row.scopeId === deviceId));
  applicable.sort((a, b) =>
    rank[a.scopeType] - rank[b.scopeType]
    || (a.scopeType === "organization" ? orgIds.indexOf(a.scopeId!) - orgIds.indexOf(b.scopeId!) : 0)
    || a.priority - b.priority
    || a.revision - b.revision);
  return applicable.map((row) => ({ ...row, document: JSON.parse(row.document), locks: JSON.parse(row.locks) }));
}

export function resolvePolicyForDeviceFromDb(db: Database.Database, deviceId: string): ResolvedPolicy {
  const epoch = desiredStateEpoch(db);
  if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(deviceId)) return { revision: 0, epoch, document: {}, locks: {} };
  return resolvePolicy(policyLayersForDeviceFromDb(db, deviceId), epoch);
}

export function resolvePolicyForDevice(deviceId: string): ResolvedPolicy {
  return resolvePolicyForDeviceFromDb(useDatabase(), deviceId);
}

export type PolicyPublishInput = {
  name: string;
  document: Record<string, unknown>;
  scopeType: PolicyLayer["scopeType"];
  scopeId: string | null;
  priority: number;
  locks: string[];
  mode?: "replace" | "append";
  baseRevision?: number | null;
};

export type PolicyPublishResult = {
  id: string;
  revision: number;
  epoch: number;
  assignmentId: string;
  documentHash: string;
  mode: "replace" | "append";
  scopeType: PolicyLayer["scopeType"];
  scopeId: string | null;
};

/**
 * 发布策略：目标存在性、调用者范围、CAS 基线与写入全部在同一个事务内完成。
 * 同一作用域复用一个稳定的 assignment 行（唯一 active revision），旧修订仅作为历史保留。
 * 回滚同样是“把旧文档作为更高修订重新发布”，从而天然满足单调 revision。
 */
export function publishPolicy(
  db: Database.Database,
  input: PolicyPublishInput,
  actor: ScopeUser,
  now = nowIso(),
): PolicyPublishResult {
  const scopeKey = input.scopeId ?? "";
  const mode = input.mode ?? "replace";
  const requestedLocks = normalizePointers(input.locks);
  return db.transaction(() => {
    if (input.scopeType === "school") {
      if (input.scopeId !== null) throw new PolicyError("school 作用域不允许指定 scopeId。", 400);
    } else if (!input.scopeId) {
      throw new PolicyError("非 school 作用域必须指定 scopeId。", 400);
    }
    if (input.scopeType === "school" || input.scopeType === "tag") {
      if (!hasSchoolWideScope(actor)) throw new PolicyError("当前账号的组织范围不足以发布该作用域的策略。", 403);
    }
    if (input.scopeType === "organization") assertOrgNodeInScope(db, actor, input.scopeId);
    if (input.scopeType === "device") {
      assertDeviceInScope(db, actor, input.scopeId!);
      if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(input.scopeId!))
        throw new PolicyError("策略引用的设备不存在。", 400);
    }
    if (input.scopeType === "tag" && !db.prepare("SELECT 1 FROM tags WHERE id=?").get(input.scopeId!))
      throw new PolicyError("策略引用的标签不存在。", 400);

    const existing = db.prepare(`SELECT pa.id assignmentId, pr.revision revision
      FROM policy_assignments pa JOIN policy_revisions pr ON pr.id=pa.policy_revision_id
      WHERE pa.superseded_at IS NULL AND pa.scope_type=? AND pa.scope_key=?`)
      .get(input.scopeType, scopeKey) as { assignmentId: string; revision: number } | undefined;
    const currentRevision = existing?.revision ?? 0;
    if (input.baseRevision !== undefined && input.baseRevision !== null && input.baseRevision !== currentRevision)
      throw new PolicyConflictError(`策略已在别处更新（当前 R${currentRevision}，提交基于 R${input.baseRevision}）。`);

    // 追加覆盖：以该作用域当前有效修订为基线，只覆盖本次给出的项，锁取并集。
    const baseRow = mode === "append" && existing
      ? db.prepare(`SELECT pr.document document, pa.locks locks
          FROM policy_assignments pa JOIN policy_revisions pr ON pr.id=pa.policy_revision_id
          WHERE pa.id=?`).get(existing.assignmentId) as { document: string; locks: string } | undefined
      : undefined;
    const document = baseRow
      ? mergePolicyDocuments(JSON.parse(baseRow.document) as Record<string, unknown>, input.document)
      : input.document;
    const locks = baseRow
      ? normalizePointers([...(JSON.parse(baseRow.locks) as string[]), ...requestedLocks])
      : requestedLocks;
    const serialized = JSON.stringify(document);
    const documentHash = sha256(serialized);

    const current = db.prepare("SELECT COALESCE(MAX(revision),0) value FROM policy_revisions").get() as { value: number };
    const nextRevision = current.value + 1;
    const revisionId = randomUUID();
    const assignmentId = existing?.assignmentId ?? randomUUID();
    db.prepare("INSERT INTO policy_revisions (id,revision,name,document,document_hash,base_revision,created_by,created_at,mode) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(revisionId, nextRevision, input.name, serialized, documentHash, input.baseRevision ?? null, actor.id, now, mode);
    db.prepare(`INSERT INTO policy_assignments (id,policy_revision_id,scope_type,scope_id,scope_key,priority,locks,created_at,superseded_at)
      VALUES (?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(scope_type, scope_key) WHERE superseded_at IS NULL
      DO UPDATE SET policy_revision_id=excluded.policy_revision_id, priority=excluded.priority, locks=excluded.locks, created_at=excluded.created_at`)
      .run(assignmentId, revisionId, input.scopeType, input.scopeId, scopeKey, input.priority, JSON.stringify(locks), now);
    const epoch = bumpDesiredStateEpoch(db, now);
    appendAuditWithin(db, {
      actorType: "user", actorId: actor.id, action: "policy.publish", targetType: "policy_revision", targetId: revisionId,
      summary: `发布策略 R${nextRevision} · ${input.name}`,
      details: { scopeType: input.scopeType, scopeId: input.scopeId, locks, epoch, baseRevision: input.baseRevision ?? null, assignmentId, mode },
    });
    return { id: revisionId, revision: nextRevision, epoch, assignmentId, documentHash, mode, scopeType: input.scopeType, scopeId: input.scopeId };
  })();
}

/**
 * 将策略文档中的 { "$config": "配置ID" } 叶子就地替换为配置库当前文档。
 * 支持顶层 { "$config": "..." } 以及任意嵌套位置。
 */
export function materializeConfigReferences(node: unknown, seen = new Set<string>()): unknown {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => materializeConfigReferences(item, seen));
  const record = node as Record<string, unknown>;
  if (typeof record["$config"] === "string" && Object.keys(record).length === 1) {
    const configurationId = record["$config"] as string;
    if (seen.has(configurationId)) throw new Error(`配置引用形成循环: ${configurationId}`);
    const db = useDatabase();
    const row = db.prepare(`SELECT cr.document FROM configurations c JOIN configuration_revisions cr ON cr.id=c.current_revision_id WHERE c.id=?`).get(configurationId) as { document: string } | undefined;
    if (!row) throw new Error(`配置 ${configurationId} 不存在或没有修订。`);
    seen.add(configurationId);
    const result = materializeConfigReferences(JSON.parse(row.document), seen);
    seen.delete(configurationId);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) result[key] = materializeConfigReferences(value, seen);
  return result;
}