import { z } from "zod";
import { getHeader } from "h3";
import { evaluateIdempotency, findIdempotentTask, isUniqueConstraintError } from "../../../utils/tasks";
import { canonicalJson, sha256 } from "../../../utils/security";
import { createTaskWithin, taskSelectorSchema } from "../../../utils/task-create";

const taskSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capabilityId: z.string().min(3).max(100),
  schemaVersion: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()),
  // 兼容旧调用方：显式设备列表仍可用；新调用方可用 targets 选择器。
  deviceIds: z.array(z.string().uuid()).max(1000).optional().transform((ids) => (ids ? [...new Set(ids)] : ids)),
  targets: z.array(taskSelectorSchema).min(1).max(1000).optional(),
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
  const db = useDatabase();
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

  let result: Awaited<ReturnType<typeof createTaskWithin>>;
  try {
    result = createTaskWithin(db, {
      ...input.data,
      idempotency: idempotencyKey ? { key: idempotencyKey, actorId: user.id, requestHash } : null,
    }, user);
  } catch (error) {
    // 并发下同一幂等键可能同时通过预检查：唯一索引兜底，冲突后回放既有任务或显式报冲突。
    if (idempotencyKey && isUniqueConstraintError(error)) {
      const decision = evaluateIdempotency(findIdempotentTask(db, user.id, idempotencyKey), requestHash);
      if (decision.kind === "conflict") throw createError({ statusCode: 409, message: "该幂等键已用于不同的任务请求。" });
      if (decision.kind === "replay") return { id: decision.task.id, state: decision.task.state, deduplicated: true };
    }
    throw error;
  }
  if (!result.ok) throw createError({ statusCode: result.statusCode, message: result.message });
  return { id: result.id, state: result.state, expiresAt: result.expiresAt };
});
