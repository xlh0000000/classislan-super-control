import { UserError, setUserDisabled } from "../../../../../utils/users";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "users.write");
  assertSchoolWideScope(user, "用户管理");
  const id = getRouterParam(event, "id")!;
  if (id === user.id) throw createError({ statusCode: 400, message: "不能停用当前登录账号。" });
  try {
    return setUserDisabled(useDatabase(), user.id, id, true);
  } catch (error) {
    if (error instanceof UserError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});