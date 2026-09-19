import { assertDeviceInScope } from "../../../../../utils/scope";
import { listDeviceTeachers } from "../../../../../utils/teacher-bindings";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.read");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  return { teachers: listDeviceTeachers(db, id) };
});
