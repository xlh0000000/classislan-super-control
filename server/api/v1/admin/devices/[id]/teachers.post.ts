import { z } from "zod";
import { assertDeviceInScope, isTeacher } from "../../../../../utils/scope";
import { bindTeacher } from "../../../../../utils/teacher-bindings";

const bindSchema = z.object({ userId: z.string().uuid() });

/**
 * 管理端把教师绑到设备上。教师本人不能走这条路：那等于谁都能把自己塞进别人的讲台机，
 * 教师侧的入口是扫设备屏上的一次性绑定码（见 teacher-bindings）。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "binding.write");
  if (isTeacher(user)) throw createError({ statusCode: 403, message: "教师请改用设备上的绑定码。" });
  const id = getRouterParam(event, "id")!;
  const input = bindSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "绑定信息无效。" });
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  return bindTeacher(db, user.id, id, input.data.userId);
});
