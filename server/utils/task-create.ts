import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { batchSizes } from "./tasks";
import { appendAuditWithin } from "./security";
import { assertOrgNodeInScope, deviceScopeFilter } from "./scope";

/**
 * 任务创建的唯一入口：HTTP 管理端、周期调度派生、事件触发派生共用同一套
 * 目标解析、能力校验、批次拆分与审计语义，避免三处各写一份而行为漂移。
 */

export const taskSelectorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device"), id: z.string().uuid() }),
  z.object({ type: z.literal("organization"), id: z.string().uuid() }),
  z.object({ type: z.literal("tag"), id: z.string().uuid() }),
]);

export type TaskSelector = z.infer<typeof taskSelectorSchema>;

export type TaskActor = { id: string | null; role: string; scopeOrgNodeId?: string | null };

export type TaskCreateInput = {
  name: string;
  capabilityId: string;
  schemaVersion?: number | null;
  payload: Record<string, unknown>;
  deviceIds?: string[] | null;
  targets?: TaskSelector[] | null;
  /** 定时启动时刻（ISO）；缺省立即 running。 */
  scheduledAt?: string | null;
  ttlMinutes: number;
  mode: string;
  batchSize?: number | null;
  percent?: number | null;
  failureThresholdPercent: number;
  maxConcurrency: number;
  maxAttempts: number;
  /** 幂等键三元组：仅 HTTP 入口使用，派生任务不需要。 */
  idempotency?: { key: string; actorId: string; requestHash: string } | null;
};

export type TaskCreateResult =
  | { ok: true; id: string; state: string; expiresAt: string }
  | { ok: false; statusCode: number; message: string };

export type TaskCreateOptions = {
  /** 审计事件动作前缀来源（task/schedule/trigger），缺省 task。 */
  auditSource?: string;
  /** 派生来源（周期定义或触发器）id，写进审计 details 方便追溯。 */
  sourceId?: string | null;
};

export function createTaskWithin(
  db: Database.Database,
  input: TaskCreateInput,
  actor: TaskActor,
  options: TaskCreateOptions = {},
): TaskCreateResult {
  if (input.mode === "fixed" && !input.batchSize)
    return { ok: false, statusCode: 400, message: "固定批次模式必须提供 batchSize。" };
  if (input.mode === "percent" && !input.percent)
    return { ok: false, statusCode: 400, message: "百分比灰度模式必须提供 percent。" };

  const scope = deviceScopeFilter(db, actor as { id: string; role: string; scopeOrgNodeId?: string | null });

  // 目标解析：显式设备 + 组织子树 + 标签，合并去重后得到不可变设备集合。
  const resolved = new Map<string, string | null>();
  const collect = (rows: { id: string; orgNodeId: string | null }[]) => { for (const row of rows) resolved.set(row.id, row.orgNodeId); };
  const selectors = input.targets ?? [];
  const explicitIds = [...new Set([...(input.deviceIds ?? []), ...selectors.filter((selector) => selector.type === "device").map((selector) => selector.id)])];
  if (explicitIds.length) {
    const placeholders = explicitIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT d.id,d.org_node_id orgNodeId FROM devices d
      WHERE d.id IN (${placeholders}) AND d.disabled_at IS NULL AND ${scope.sql}`).all(...explicitIds, ...scope.params) as { id: string; orgNodeId: string | null }[];
    if (rows.length !== explicitIds.length)
      return { ok: false, statusCode: 400, message: "任务目标包含不存在、已禁用或超出权限范围的设备。" };
    collect(rows);
  }
  for (const selector of selectors.filter((item) => item.type === "organization")) {
    const node = db.prepare("SELECT path FROM org_nodes WHERE id=?").get(selector.id) as { path: string } | undefined;
    if (!node) return { ok: false, statusCode: 404, message: "目标组织不存在。" };
    try {
      assertOrgNodeInScope(db, actor as { id: string; role: string; scopeOrgNodeId?: string | null }, selector.id);
    } catch {
      return { ok: false, statusCode: 403, message: "目标组织超出权限范围。" };
    }
    const prefix = node.path === "/" ? "/%" : `${node.path}/%`;
    const rows = db.prepare(`SELECT d.id,d.org_node_id orgNodeId FROM devices d JOIN org_nodes o ON o.id=d.org_node_id
      WHERE (o.id=? OR o.path LIKE ?) AND d.disabled_at IS NULL AND ${scope.sql}`).all(selector.id, prefix, ...scope.params) as { id: string; orgNodeId: string | null }[];
    collect(rows);
  }
  for (const selector of selectors.filter((item) => item.type === "tag")) {
    const tag = db.prepare("SELECT id FROM tags WHERE id=?").get(selector.id);
    if (!tag) return { ok: false, statusCode: 404, message: "目标标签不存在。" };
    const rows = db.prepare(`SELECT d.id,d.org_node_id orgNodeId FROM devices d JOIN device_tags dt ON dt.device_id=d.id
      WHERE dt.tag_id=? AND d.disabled_at IS NULL AND ${scope.sql}`).all(selector.id, ...scope.params) as { id: string; orgNodeId: string | null }[];
    collect(rows);
  }
  const deviceIds = [...resolved.keys()];
  if (!deviceIds.length) return { ok: false, statusCode: 400, message: "目标解析后没有任何可用设备。" };
  if (input.mode === "all" && input.maxConcurrency > 0 && deviceIds.length > input.maxConcurrency)
    return { ok: false, statusCode: 400, message: "all 模式下 maxConcurrency 应不小于设备总数。" };

  const placeholders = deviceIds.map(() => "?").join(",");
  const devices = db.prepare(`SELECT d.id,d.org_node_id orgNodeId,d.disabled_at disabledAt,c.capabilities
    FROM devices d LEFT JOIN capability_snapshots c ON c.device_id=d.id
    WHERE d.id IN (${placeholders}) AND ${scope.sql}`).all(...deviceIds, ...scope.params) as
    { id: string; orgNodeId: string | null; disabledAt: string | null; capabilities: string | null }[];
  if (devices.length !== deviceIds.length) return { ok: false, statusCode: 400, message: "任务包含不存在的设备。" };
  if (devices.some((device) => device.disabledAt)) return { ok: false, statusCode: 409, message: "任务包含已禁用的设备。" };
  const unsupported = devices.filter((device) => {
    if (!device.capabilities) return true;
    try {
      const capabilities = JSON.parse(device.capabilities) as { id: string; schemaVersion?: number }[];
      const match = capabilities.find((capability) => capability.id === input.capabilityId);
      if (!match) return true;
      if (input.schemaVersion && match.schemaVersion && match.schemaVersion < input.schemaVersion) return true;
      return false;
    } catch { return true; }
  });
  if (unsupported.length) return { ok: false, statusCode: 409, message: `有 ${unsupported.length} 台设备未声明支持能力 ${input.capabilityId}。` };

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const notBefore = input.scheduledAt ?? createdAt;
  const expiresAt = new Date(new Date(notBefore).getTime() + input.ttlMinutes * 60_000).toISOString();
  const payload = JSON.stringify(input.payload);
  const sizes = batchSizes(deviceIds.length, input.mode, input.batchSize ?? null, input.percent ?? null);
  db.transaction(() => {
    const snapshot = deviceIds.map((deviceId) => ({ id: deviceId, orgNodeId: resolved.get(deviceId) ?? null }));
    db.prepare(`INSERT INTO tasks
      (id,name,capability_id,state,payload,scheduled_at,expires_at,created_by,created_at,updated_at,
       mode,batch_size,percent,failure_threshold,max_concurrency,cancel_requested,idempotency_key,idempotency_actor_id,idempotency_request_hash,target_snapshot)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`)
      .run(id, input.name, input.capabilityId, input.scheduledAt ? "scheduled" : "running", payload, input.scheduledAt ?? null, expiresAt, actor.id, createdAt, createdAt,
        input.mode, input.mode === "fixed" ? input.batchSize : null, input.mode === "percent" ? input.percent : null,
        input.failureThresholdPercent, input.maxConcurrency,
        input.idempotency?.key ?? null, input.idempotency?.actorId ?? null, input.idempotency?.requestHash ?? null,
        JSON.stringify(snapshot));
    const insertBatch = db.prepare(`INSERT INTO task_batches (id,task_id,batch_index,device_ids,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`);
    let offset = 0;
    sizes.forEach((size, index) => {
      const members = deviceIds.slice(offset, offset + size);
      offset += size;
      insertBatch.run(randomUUID(), id, index, JSON.stringify(members), index === 0 ? "active" : "pending", createdAt, createdAt);
    });
    if (sizes[0] && input.mode === "all") {
      const insertCommand = db.prepare(`INSERT INTO commands
        (id,task_id,device_id,capability_id,payload,not_before,expires_at,state,max_attempts,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const deviceId of deviceIds)
        insertCommand.run(randomUUID(), id, deviceId, input.capabilityId, payload, notBefore, expiresAt, "pending", input.maxAttempts, createdAt);
    }
    appendAuditWithin(db, {
      actorType: actor.id ? "user" : "system", actorId: actor.id ?? undefined,
      action: "task.create", targetType: "task", targetId: id,
      summary: `创建任务 ${input.name}`,
      details: {
        capabilityId: input.capabilityId, targets: deviceIds.length, mode: input.mode, expiresAt,
        ...(options.sourceId ? { source: options.auditSource ?? "task", sourceId: options.sourceId } : {}),
      },
    });
  })();
  return { ok: true, id, state: input.scheduledAt ? "scheduled" : "running", expiresAt };
}
