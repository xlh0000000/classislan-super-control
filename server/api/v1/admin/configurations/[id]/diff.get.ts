import { z } from "zod";

const querySchema = z.object({ from: z.coerce.number().int().positive().optional(), to: z.coerce.number().int().positive().optional() });

function diffValues(a: unknown, b: unknown): unknown {
  if (a === b) return undefined;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    const changes: Record<string, unknown> = {};
    for (const key of keys) {
      const delta = diffValues(left[key], right[key]);
      if (delta !== undefined) changes[key] = delta;
    }
    return Object.keys(changes).length ? changes : undefined;
  }
  return { from: a, to: b };
}

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "configurations.read");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const query = querySchema.safeParse(getQuery(event));
  if (!query.success) throw createError({ statusCode: 400, message: "diff 参数无效。" });
  const db = useDatabase();
  const current = (db.prepare("SELECT current_revision_id currentRevisionId FROM configurations WHERE id=?").get(id) as { currentRevisionId: string | null } | undefined);
  if (!current) throw createError({ statusCode: 404, message: "配置不存在。" });
  const to = query.data.to ?? ((db.prepare("SELECT revision FROM configuration_revisions WHERE id=?").get(current.currentRevisionId ?? "") as { revision: number } | undefined)?.revision ?? 0);
  const revisions = db.prepare(`SELECT revision,document FROM configuration_revisions WHERE configuration_id=? AND revision IN (?,?)`).all(id, query.data.from ?? 0, to) as { revision: number; document: string }[];
  const fromDoc = revisions.find((row) => row.revision === (query.data.from ?? 0))?.document ?? "{}";
  const toDoc = revisions.find((row) => row.revision === to)?.document ?? "{}";
  let fromJson: unknown;
  let toJson: unknown;
  try { fromJson = JSON.parse(fromDoc); } catch { fromJson = {}; }
  try { toJson = JSON.parse(toDoc); } catch { toJson = {}; }
  return { from: query.data.from ?? 0, to, changes: diffValues(fromJson, toJson) ?? {} };
});