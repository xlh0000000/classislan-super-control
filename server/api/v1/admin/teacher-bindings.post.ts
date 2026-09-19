import { z } from "zod";
import { redeemBindingCode } from "../../../utils/teacher-bindings";

const redeemSchema = z.object({
  deviceId: z.string().uuid(),
  code: z.string().trim().min(8).max(32),
});

/**
 * 扫码兑换绑定：教师手机端扫到设备屏上的一次性码后，把 { 设备 id, 码 } 交给服务端，
 * 换回一条绑定关系。码只能用一次，兑换成功即作废。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "binding.write");
  const input = redeemSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "绑定信息无效。" });
  return redeemBindingCode(useDatabase(), user.id, input.data.deviceId, input.data.code);
});
