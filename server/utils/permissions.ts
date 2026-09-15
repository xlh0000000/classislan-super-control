const rolePermissions: Record<string, Set<string>> = {
  owner: new Set(["*"]),
  admin: new Set(["dashboard.read", "devices.read", "enrollment.write", "devices.write", "organization.read", "organization.write", "policies.read", "policies.write", "configurations.read", "configurations.write", "tasks.read", "tasks.write", "audit.read", "system.read", "system.write", "users.read", "users.write", "rollcall.read", "rollcall.write"]),
  operator: new Set(["dashboard.read", "devices.read", "devices.write", "tasks.read", "tasks.write", "audit.read", "rollcall.read"]),
  auditor: new Set(["audit.read"]),
  viewer: new Set(["dashboard.read", "devices.read", "organization.read", "policies.read", "configurations.read", "tasks.read", "system.read", "rollcall.read"]),
};

export function requirePermission(user: { role: string }, permission: string) {
  const permissions = rolePermissions[user.role] ?? new Set<string>();
  if (!permissions.has("*") && !permissions.has(permission))
    throw createError({ statusCode: 403, message: "当前角色没有执行此操作的权限。" });
}