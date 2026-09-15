import { assertDeviceInScope } from "../../../../../utils/scope";
import { materializeConfigReferences, policyLayersForDeviceFromDb, resolvePolicyForDeviceFromDb } from "../../../../../utils/policy";
import { canonicalJson, sha256 } from "../../../../../utils/security";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.read");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  const device = db.prepare(`SELECT d.id,d.name,d.last_seen_at lastSeenAt,d.disabled_at disabledAt,
    CASE WHEN d.disabled_at IS NULL AND unixepoch(d.last_seen_at) > unixepoch('now')-45 THEN 1 ELSE 0 END online,
    d.policy_revision policyRevision,d.policy_epoch policyEpoch,
    d.applied_policy_hash appliedPolicyHash,d.applied_policy_sections appliedPolicySections,d.drift_count driftCount
    FROM devices d WHERE d.id=?`).get(id) as {
      id: string; name: string; lastSeenAt: string | null; disabledAt: string | null; online: number;
      policyRevision: number; policyEpoch: number;
      appliedPolicyHash: string; appliedPolicySections: string | null; driftCount: number;
    } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  const layers = policyLayersForDeviceFromDb(db, id);
  const resolved = resolvePolicyForDeviceFromDb(db, id);
  const desiredHash = sha256(canonicalJson(materializeConfigReferences(resolved.document)));
  let appliedSections: unknown = {};
  if (device.appliedPolicySections) {
    try { appliedSections = JSON.parse(device.appliedPolicySections); } catch { appliedSections = {}; }
  }
  return {
    device: {
      id: device.id, name: device.name, online: device.online === 1,
      disabled: device.disabledAt !== null, lastSeenAt: device.lastSeenAt,
    },
    layers: layers.map((layer) => ({
      revisionId: layer.revisionId, revision: layer.revision, name: layer.name,
      scopeType: layer.scopeType, scopeId: layer.scopeId, priority: layer.priority, mode: layer.mode,
      lockedPointers: layer.locks.length, sections: Object.keys(layer.document),
    })),
    resolved: { revision: resolved.revision, epoch: resolved.epoch, hash: desiredHash, sections: Object.keys(resolved.document), locks: resolved.locks },
    applied: {
      revision: device.policyRevision, epoch: device.policyEpoch, hash: device.appliedPolicyHash,
      sections: appliedSections, driftCount: device.driftCount,
    },
    inSync: device.policyEpoch === resolved.epoch && device.appliedPolicyHash === desiredHash,
  };
});