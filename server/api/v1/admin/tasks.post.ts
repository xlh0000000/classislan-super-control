import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getHeader } from "h3";
import { batchSizes, evaluateIdempotency, findIdempotentTask, isUniqueConstraintError } from "../../../utils/tasks";
import { canonicalJson, sha256 } from "../../../utils/security";
import { assertOrgNodeInScope, deviceScopeFilter } from "../../../utils/scope";

/**
 * 任务目标选择器：显式设备、组织子树、标签。选择器在创建事务内解析为不可变设备快照，
 * 之后设备加入/退出组织或标签都不会改变已下发任务的受众。
 */
const selectorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device"), id: z.string().uuid() }),
  z.object({ type: z.literal("organization"), id: z.string().uuid() }),
  z.object({ type: z.literal("tag"), id: z.string().uuid() }),
]);

const taskSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capabilityId: z.string().min(3).max(100),
  schemaVersion: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()),
  // 兼容旧调用方：显式设备列表仍可用；新调用方可用 targets 选择器。
  deviceIds: z.array(z.string().uuid()).max(1000).optional().transform((ids) => (ids ? [...new Set(ids)] : ids)),
  targets: z.array(selectorSchema).min(1).max(1000).optional(),
  scheduledAt: z.string().datetime().optional(),
  ttlMinutes: z.number().int().min(1).max(10080).default(60),
  mode: z.enum(["all", "fixed", "percent"]).default("all"),
  batchSize: z.number().int().min(1).max(500).optional(),
  percent: z.number().int().min(1).max(100).optional(),
  failureThresholdPercent: z.number().int().min(0).max(100).default(0),
  maxConcurrency: z.number().int().min(0).max(1000).default(0),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).refine((value) => (value.deviceIds?.length ?? 0) > 0 || (value.targets?.length ?? 0) > 0, {
  message: "必须提供目标设备或目标选择器。",
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "tasks.write");
  const input = taskSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "任务定义无效。" });
  if (input.data.mode === "fixed" && !input.data.batchSize)
    throw createError({ statusCode: 400, message: "固定批次模式必须提供 batchSize。" });
  if (input.data.mode === "percent" && !input.data.percent)
    throw createError({ statusCode: 400, message: "百分比灰度模式必须提供 percent。" });
  const db = useDatabase();
  const scope = deviceScopeFilter(db, user);
  // 幂等键既可写在请求体，也可用标准 Idempotency-Key 头，二者同时给出时以请求体为准。
  const headerKey = (getHeader(event, "idempotency-key") || "").trim();
  if (headerKey.length > 200) throw createError({ statusCode: 400, message: "Idempotency-Key 过长。" });
  const idempotencyKey = input.data.idempotencyKey ?? (headerKey || undefined);
  // 摘要覆盖全部影响结果的字段：同键不同请求必须显式冲突，而不是静默回放成别人的任务。
  const requestHash = sha256(canonicalJson({
    name: input.data.name, capabilityId: input.data.capabilityId, schemaVersion: input.data.schemaVersion ?? null,
    payload: input.data.payload, deviceIds: input.data.deviceIds ?? [], targets: input.data.targets ?? [],
    scheduledAt: input.data.scheduledAt ?? null, ttlMinutes: input.data.ttlMinutes, mode: input.data.mode,
    batchSize: input.data.batchSize ?? null, percent: input.data.percent ?? null,
    failureThresholdPercent: input.data.failureThresholdPercent, maxConcurrency: input.data.maxConcurrency, maxAttempts: input.data.maxAttempts,
  }));
  if (idempotencyKey) {
    const decision = evaluateIdempotency(findIdempotentTask(db, user.id, idempotencyKey), requestHash);
    if (decision.kind === "conflict") throw createError({ statusCode: 409, message: "该幂等键已用于不同的任务请求。" });
    if (decision.kind === "replay") return { id: decision.task.id, state: decision.task.state, deduplicated: true };
  }

  // 目标解析：显式设备 + 组织子树 + 标签，合并去重后得到不可变设备集合。
  const resolved = new Map<string, string | null>();
  const collect = (rows: { id: string; orgNodeId: string | null }[]) => { for (const row of rows) resolved.set(row.id, row.orgNodeId); };
  const selectors = input.data.targets ?? [];
  const explicitIds = [...new Set([...(input.data.deviceIds ?? []), ...selectors.filter((selector) => selector.type === "device").map((selector) => selector.id)])];
  if (explicitIds.length) {
    const placeholders = explicitIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT d.id,d.org_node_id orgNodeId FROM devices d
      WHERE d.id IN (${placeholders}) AND d.disabled_at IS NULL AND ${scope.sql}`).all(...explicitIds, ...scope.params) as { id: string; orgNodeId: string | null }[];
    if (rows.length !== explicitIds.length)
      throw createError({ statusCode: 400, message: "任务目标包含不存在、已禁用或超出权限范围的设备。" });
    collect(rows);
  }
  for (const selector of selectors.filter((item) => item.type === "organization")) {
    const node = db.prepare("SELECT path FROM org_nodes WHERE id=?").get(selector.id) as { path: string } | undefined;
    if (!node) throw createError({ statusCode: 404, message: "目标组织不存在。" });
    assertOrgNodeInScope(db, user, selector.id);
    const prefix = node.path === "/" ? "/%" : `${node.path}/%`;
    const rows = db.prepare(`SELECT d.id,d.org_node_id orgNodeId FROM devices d JOIN org_nodes o ON o.id=d.org_node_id
      WHERE (o.id=? OR o.path LIKE ?) AND d.disabled_at IS NULL AND ${scope.sql}`).all(selector.id, prefix, ...scope.params) as { id: string; orgNodeId: string | null }[];
    collect(rows);
  }
  for (const selector of selectors.filter((item) => item.type === "tag")) {
    const tag = db.prepare("SELECT id FROM tags WHERE id=?").get(selector.id);
    if (!tag) throw createError({ statusCode: 404, message: "目标标签不存在。" });
    const rows = db.prepare(`SELECT d.id,d.org_node_id orgNodeId FROM devices d JOIN device_tags dt ON dt.device_id=d.id
      WHERE dt.tag_id=? AND d.disabled_at IS NULL AND ${scope.sql}`).all(selector.id, ...scope.params) as { id: string; orgNodeId: string | null }[];
    collect(rows);
  }
  const deviceIds = [...resolved.keys()];
  if (!deviceIds.length) throw createError({ statusCode: 400, message: "目标解析后没有任何可用设备。" });
  if (input.data.mode === "all" && input.data.maxConcurrency > 0 && deviceIds.length > input.data.maxConcurrency)
    throw createError({ statusCode: 400, message: "all 模式下 maxConcurrency 应不小于设备总数。" });

  const placeholders = deviceIds.map(() => "?").join(",");
  const devices = db.prepare(`SELECT d.id,d.org_node_id orgNodeId,d.disabled_at disabledAt,c.capabilities
    FROM devices d LEFT JOIN capability_snapshots c ON c.device_id=d.id
    WHERE d.id IN (${placeholders}) AND ${scope.sql}`).all(...deviceIds, ...scope.params) as { id: string; orgNodeId: string | null; disabledAt: string | null; capabilities: string | null }[];
  if (devices.length !== deviceIds.length) throw createError({ statusCode: 400, message: "任务包含不存在的设备。" });
  if (devices.some((device) => device.disabledAt)) throw createError({ statusCode: 409, message: "任务包含已禁用的设备。" });
  const unsupported = devices.filter((device) => {
    if (!device.capabilities) return true;
    try {
      const capabilities = JSON.parse(device.capabilities) as { id: string; schemaVersion?: number }[];
      const match = capabilities.find((capability) => capability.id === input.data.capabilityId);
      if (!match) return true;
      if (input.data.schemaVersion && match.schemaVersion && match.schemaVersion < input.data.schemaVersion) return true;
      return false;
    } catch { return true; }
  });
  if (unsupported.length) throw createError({ statusCode: 409, message: `有 ${unsupported.length} 台设备未声明支持能力 ${input.data.capabilityId}。` });

  const id = randomUUID();
  const createdAt = nowIso();
  const notBefore = input.data.scheduledAt ?? createdAt;
  const expiresAt = new Date(new Date(notBefore).getTime() + input.data.ttlMinutes * 60_000).toISOString();
  const payload = JSON.stringify(input.data.payload);
  const sizes = batchSizes(deviceIds.length, input.data.mode, input.data.batchSize ?? null, input.data.percent ?? null);
  const create = db.transaction(() => {
    const snapshot = deviceIds.map((deviceId) => ({ id: deviceId, orgNodeId: resolved.get(deviceId) ?? null }));
    db.prepare(`INSERT INTO tasks
      (id,name,capability_id,state,payload,scheduled_at,expires_at,created_by,created_at,updated_at,
       mode,batch_size,percent,failure_threshold,max_concurrency,cancel_requested,idempotency_key,idempotency_actor_id,idempotency_request_hash,target_snapshot)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`)
      .run(id, input.data.name, input.data.capabilityId, input.data.scheduledAt ? "scheduled" : "running", payload, input.data.scheduledAt ?? null, expiresAt, user.id, createdAt, createdAt,
        input.data.mode, input.data.mode === "fixed" ? input.data.batchSize : null, input.data.mode === "percent" ? input.data.percent : null,
        input.data.failureThresholdPercent, input.data.maxConcurrency, idempotencyKey ?? null, idempotencyKey ? user.id : null, idempotencyKey ? requestHash : null, JSON.stringify(snapshot));
    const insertBatch = db.prepare(`INSERT INTO task_batches (id,task_id,batch_index,device_ids,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`);
    let offset = 0;
    sizes.forEach((size, index) => {
      const members = deviceIds.slice(offset, offset + size);
      offset += size;
      insertBatch.run(randomUUID(), id, index, JSON.stringify(members), index === 0 ? "active" : "pending", createdAt, createdAt);
    });
    if (sizes[0] && input.data.mode === "all") {
      const insertCommand = db.prepare(`INSERT INTO commands
        (id,task_id,device_id,capability_id,payload,not_before,expires_at,state,max_attempts,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const deviceId of deviceIds)
        insertCommand.run(randomUUID(), id, deviceId, input.data.capabilityId, payload, notBefore, expiresAt, "pending", input.data.maxAttempts, createdAt);
    }
    appendAuditWithin(db, { actorType: "user", actorId: user.id, action: "task.create", targetType: "task", targetId: id, summary: `创建任务 ${input.data.name}`, details: { capabilityId: input.data.capabilityId, targets: deviceIds.length, selectors, mode: input.data.mode, expiresAt } });
  });
  try {
    create();
  } catch (error) {
    // 并发下同一幂等键可能同时通过预检查：唯一索引兜底，冲突后回放既有任务或显式报冲突。
    if (idempotencyKey && isUniqueConstraintError(error)) {
      const decision = evaluateIdempotency(findIdempotentTask(db, user.id, idempotencyKey), requestHash);
      if (decision.kind === "conflict") throw createError({ statusCode: 409, message: "该幂等键已用于不同的任务请求。" });
      if (decision.kind === "replay") return { id: decision.task.id, state: decision.task.state, deduplicated: true };
    }
    throw error;
  }
  return { id, state: input.data.scheduledAt ? "scheduled" : "running", expiresAt };
});