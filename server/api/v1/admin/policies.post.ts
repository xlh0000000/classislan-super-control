import { policyPublishSchema } from "../../../../shared/schemas";
import { PolicyError, publishPolicy } from "../../../utils/policy";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "policies.write");
  const parsed = policyPublishSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "策略发布信息无效。", data: { issues: parsed.error.issues } });
  const input = parsed.data;
  const scopeId = input.scopeType === "school" ? null : input.scopeId;
  // If-Match 是可选的等价并发来源：支持 "R5" / "5" / W/"R5"。
  let baseRevision: number | null | undefined = input.baseRevision;
  const ifMatch = getHeader(event, "if-match");
  if ((baseRevision === undefined || baseRevision === null) && ifMatch) {
    const match = /^(?:W\/)?"?(?:R)?(\d+)"?$/.exec(ifMatch.trim());
    if (!match) throw createError({ statusCode: 400, message: "If-Match 头格式无效。" });
    baseRevision = Number(match[1]);
  }
  try {
    return publishPolicy(useDatabase(), { ...input, scopeId, baseRevision }, user);
  } catch (error) {
    if (error instanceof PolicyError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});