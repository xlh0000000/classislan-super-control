import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { nowIso, useDatabase } from "./database";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** 定长填充后的恒定时间字符串比较，避免令牌校验泄露长度与内容。 */
export function timingSafeEqualText(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBytes.length === rightBytes.length;
}

export type AuditInput = {
  actorType: "user" | "device" | "system";
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  summary: string;
  details?: unknown;
};

export type Database = ReturnType<typeof useDatabase>;

/**
 * 在当前事务（或隐式事务）内追加一条审计事件。
 * 调用方必须保证自己处于事务中，或经由 appendAudit/withAuditedTransaction 调用，
 * 以便审计序列号与哈希链在并发下保持单调。
 */
export function appendAuditWithin(db: Database, input: AuditInput) {
  const last = db.prepare("SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1").get() as { sequence: number; event_hash: string } | undefined;
  const event = {
    id: randomUUID(), sequence: (last?.sequence ?? 0) + 1,
    actorType: input.actorType, actorId: input.actorId ?? null,
    action: input.action, targetType: input.targetType, targetId: input.targetId ?? null,
    summary: input.summary, details: input.details ?? {}, previousHash: last?.event_hash ?? "",
    createdAt: nowIso(),
  };
  const eventHash = sha256(canonicalJson(event));
  db.prepare(`INSERT INTO audit_events
    (id, sequence, actor_type, actor_id, action, target_type, target_id, summary, details, previous_hash, event_hash, created_at)
    VALUES (@id,@sequence,@actorType,@actorId,@action,@targetType,@targetId,@summary,@details,@previousHash,@eventHash,@createdAt)`)
    .run({ ...event, details: JSON.stringify(event.details), eventHash });
  return { ...event, eventHash };
}

export function appendAudit(input: AuditInput) {
  const db = useDatabase();
  return db.transaction(() => appendAuditWithin(db, input))();
}

/**
 * 把业务写入与审计追加放进同一个事务：任一步骤抛错都会整体回滚，
 * 避免出现“业务已生效但审计缺失”或反过来的不一致窗口。
 */
export function withAuditedTransaction<T>(
  work: (db: Database) => T,
  audit: (result: T) => AuditInput,
): T {
  const db = useDatabase();
  return db.transaction(() => {
    const result = work(db);
    appendAuditWithin(db, audit(result));
    return result;
  })();
}

type AuditRow = {
  id: string; sequence: number; actor_type: string; actor_id: string | null;
  action: string; target_type: string; target_id: string | null; summary: string;
  details: string; previous_hash: string; event_hash: string; created_at: string;
};

/** 按写入时相同的规范化方式重算事件哈希，用于检测内容被改写。 */
function recomputeEventHash(row: AuditRow) {
  return sha256(canonicalJson({
    id: row.id, sequence: row.sequence,
    actorType: row.actor_type, actorId: row.actor_id,
    action: row.action, targetType: row.target_type, targetId: row.target_id,
    summary: row.summary, details: JSON.parse(row.details),
    previousHash: row.previous_hash, createdAt: row.created_at,
  }));
}

/**
 * 从头校验审计链：既检查前后哈希链接，也用行内容重算每条事件哈希，
 * 从而同时发现断链与被就地改写的事件。
 */
export function verifyAuditChain(db: ReturnType<typeof useDatabase>): { verified: boolean; lastSequence: number; lastHash: string; count: number } {
  const rows = db.prepare(`SELECT id,sequence,actor_type,actor_id,action,target_type,target_id,summary,details,previous_hash,event_hash,created_at
    FROM audit_events ORDER BY sequence ASC`).all() as AuditRow[];
  if (!rows.length) return { verified: true, lastSequence: 0, lastHash: "", count: 0 };
  let previous = "";
  for (const row of rows) {
    if (row.previous_hash !== previous) throw new Error(`审计链在序列 ${row.sequence} 断链。`);
    if (recomputeEventHash(row) !== row.event_hash) throw new Error(`审计事件 ${row.sequence} 的内容与其哈希不符。`);
    previous = row.event_hash;
  }
  const last = rows[rows.length - 1]!;
  return { verified: true, lastSequence: last.sequence, lastHash: last.event_hash, count: rows.length };
}