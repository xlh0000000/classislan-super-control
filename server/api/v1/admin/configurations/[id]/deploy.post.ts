import { z } from "zod";
import { deployConfiguration } from "../../../../../utils/deploy";
import { PolicyError } from "../../../../../utils/policy";

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
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "configurations.write");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const input = deploySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "下发目标无效。" });
  try {
    return deployConfiguration(useDatabase(), { configurationId: id, ...input.data }, user);
  } catch (error) {
    if (error instanceof PolicyError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});