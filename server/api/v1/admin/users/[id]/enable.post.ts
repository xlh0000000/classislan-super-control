import { UserError, setUserDisabled } from "../../../../../utils/users";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "users.write");
  assertSchoolWideScope(user, "用户管理");
  const id = getRouterParam(event, "id")!;
  try {
    return setUserDisabled(useDatabase(), user.id, id, false);
  } catch (error) {
    if (error instanceof UserError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});