import { z } from "zod";
import { deployConfiguration } from "../../../../../utils/deploy";
import { PolicyError } from "../../../../../utils/policy";
import { isTeacher } from "../../../../../utils/scope";

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("school") }),
  z.object({ type: z.literal("organization"), id: z.string().uuid() }),
  z.object({ type: z.literal("tag"), id: z.string().uuid() }),
  z.object({ type: z.literal("device"), id: z.string().uuid() }),
]);

const deploySchema = z.object({
  targets: z.array(targetSchema).min(1).max(1000),
  priority: z.number().int().min(-1000).max(1000).optional(),
});

/**
 * 下发配置到选定目标（全校 / 组织子树 / 标签 / 指定设备）。
 * 每个目标会在对应作用域生成一份引用该配置的策略修订，设备下次轮询即生效。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  const id = getRouterParam(event, "id")!;
  const input = deploySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "下发目标无效。" });
  const db = useDatabase();
  if (isTeacher(user)) {
    requirePermission(user, "timetable.apply");
    // 目标范围由策略发布层按绑定关系兜住，这里只挡类型：非课表配置下发会改写设备上的其他行为。
    const configuration = db.prepare("SELECT kind kind FROM configurations WHERE id=?").get(id) as { kind: string } | undefined;
    if (!configuration) throw createError({ statusCode: 404, message: "配置不存在。" });
    if (configuration.kind !== "profile") throw createError({ statusCode: 403, message: "教师只能下发课表配置。" });
  } else {
    requirePermission(user, "configurations.write");
    assertSchoolWideScope(user, "配置库");
  }
  try {
    return deployConfiguration(db, { configurationId: id, ...input.data }, user);
  } catch (error) {
    if (error instanceof PolicyError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
