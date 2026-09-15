import { layoutTree } from "../../../utils/layout";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.read");
  return layoutTree(useDatabase(), user);
});