import { resolve } from "node:path";
import { z } from "zod";

const verifySchema = z.object({ name: z.string().regex(/^[A-Za-z0-9._-]+$/) });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "system.read");
  assertSchoolWideScope(user, "系统与备份");
  const input = verifySchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "备份名称无效。" });
  const directory = resolve(backupsDirectory(), input.data.name);
  if (!directory.startsWith(backupsDirectory())) throw createError({ statusCode: 400, message: "备份路径非法。" });
  const signing = getServerSigningIdentity();
  return verifyBackup(directory, signing.keyId);
});