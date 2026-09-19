/**
 * 角色 → 权限的唯一来源：服务端在每个接口入口把关，界面按同一份表收起做不到的入口。
 * 两边共用一份，避免菜单权限表与接口权限表各说各话。
 */
export const rolePermissions: Record<string, readonly string[]> = {
  owner: ["*"],
  admin: ["dashboard.read", "devices.read", "enrollment.write", "devices.write", "binding.write", "organization.read", "organization.write", "policies.read", "policies.write", "configurations.read", "configurations.write", "timetable.apply", "tasks.read", "tasks.write", "audit.read", "system.read", "system.write", "users.read", "users.write", "rollcall.read", "rollcall.write", "crashes.read", "crashes.write"],
  operator: ["dashboard.read", "devices.read", "devices.write", "binding.write", "tasks.read", "tasks.write", "audit.read", "rollcall.read", "crashes.read"],
  auditor: ["audit.read", "crashes.read"],
  viewer: ["dashboard.read", "devices.read", "organization.read", "policies.read", "configurations.read", "tasks.read", "system.read", "rollcall.read", "crashes.read"],
  // 教师只能在绑定设备上点名与套用课表；能看到哪些设备由 device_teachers 决定。
  teacher: ["dashboard.read", "devices.read", "binding.write", "rollcall.read", "rollcall.write", "timetable.apply"],
};

export const roleLabels: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  operator: "操作员",
  auditor: "审计员",
  viewer: "只读",
  teacher: "教师",
};

export function roleCan(role: string | null | undefined, permission: string): boolean {
  const permissions = role ? rolePermissions[role] : undefined;
  if (!permissions) return false;
  return permissions.includes("*") || permissions.includes(permission);
}

/** 可由管理端挑选的角色：所有者通过转移产生，不作为直接授予项。 */
export const assignableRoles = Object.keys(roleLabels).filter((role) => role !== "owner");
