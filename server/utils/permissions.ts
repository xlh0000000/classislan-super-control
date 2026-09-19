import { roleCan } from "../../shared/permissions";

export function requirePermission(user: { role: string }, permission: string) {
  if (!roleCan(user.role, permission))
    throw createError({ statusCode: 403, message: "当前角色没有执行此操作的权限。" });
}

/** 只判断不抛错：聚合页里每项数据各有各的门槛，够不到就少给一块，而不是整页 403。 */
export function canPermission(user: { role: string }, permission: string) {
  return roleCan(user.role, permission);
}
