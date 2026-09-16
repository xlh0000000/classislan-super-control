import { assertDeviceInScope } from "../../../../../utils/scope";
import { materializeConfigReferences, resolvePolicyForDeviceFromDb } from "../../../../../utils/policy";
import { canonicalJson, sha256 } from "../../../../../utils/security";
import { readDeviceTimetable } from "../../../../../utils/device-timetable";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.read");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  const device = db.prepare(`SELECT d.id,d.name,d.org_node_id orgNodeId,d.plugin_version pluginVersion,d.app_version appVersion,d.platform,
    CASE WHEN d.disabled_at IS NULL AND unixepoch(d.last_seen_at) > unixepoch('now')-45 THEN 1 ELSE 0 END online,
    d.transport transport,d.capability_digest capabilityDigest,d.policy_revision policyRevision,d.policy_epoch policyEpoch,d.applied_policy_hash appliedPolicyHash,
    d.applied_policy_sections appliedPolicySections,d.drift_count driftCount,d.last_sequence lastSequence,d.last_seen_at lastSeenAt,
    d.created_at createdAt,d.disabled_at disabledAt,
    c.capabilities capabilitySnapshot
    FROM devices d LEFT JOIN capability_snapshots c ON c.device_id=d.id WHERE d.id=?`).get(id) as Record<string, unknown> | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  const tags = db.prepare("SELECT tag_id tagId FROM device_tags WHERE device_id=?").all(id) as { tagId: string }[];
  const recent = db.prepare(`SELECT id,capability_id capabilityId,state,attempt_count attemptCount,created_at createdAt
    FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 20`).all(id);
  let capabilities: unknown = null;
  if (device.capabilitySnapshot) { try { capabilities = JSON.parse(device.capabilitySnapshot as string); } catch { capabilities = null; } }
  let appliedSections: unknown = {};
  if (device.appliedPolicySections) {
    try { appliedSections = JSON.parse(device.appliedPolicySections as string); } catch { appliedSections = {}; }
  }

  // desired 由当前策略与成员关系实时解析；applied 来自设备最近一次轮询上报。
  // 两者 epoch/hash 一致才算同步，否则管理端应显示漂移并等待设备重同步。
  const desired = resolvePolicyForDeviceFromDb(db, id);
  const desiredHash = sha256(canonicalJson(materializeConfigReferences(desired.document)));
  const appliedHash = (device.appliedPolicyHash as string) ?? "";
  const policyStatus = {
    desired: {
      revision: desired.revision,
      epoch: desired.epoch,
      hash: desiredHash,
      sections: Object.keys(desired.document),
      lockedPointers: Object.keys(desired.locks).length,
    },
    applied: {
      revision: device.policyRevision as number,
      epoch: device.policyEpoch as number,
      hash: appliedHash,
      sections: appliedSections,
      driftCount: device.driftCount as number,
    },
    inSync: (device.policyEpoch as number) === desired.epoch && appliedHash === desiredHash,
  };
  // 课表档案（贡献者：威廉）：读取存档行，快照解析失败时回退为 null（界面显示"尚未上传"）。
  const timetableRow = readDeviceTimetable(db, id);
  let timetable: unknown = null;
  if (timetableRow) {
    try { timetable = JSON.parse(timetableRow.snapshot); } catch { timetable = null; }
  }
  const timetableStatus = timetableRow
    ? {
        digest: timetableRow.digest,
        uploadedAt: timetableRow.uploadedAt,
        subjectsCount: timetableRow.subjectsCount,
        timeLayoutsCount: timetableRow.timeLayoutsCount,
        classPlansCount: timetableRow.classPlansCount,
        classPlanGroupsCount: timetableRow.classPlanGroupsCount,
      }
    : null;
  return {
    ...device,
    online: device.online === 1,
    appliedPolicySections: appliedSections,
    capabilitySnapshot: capabilities,
    tagIds: tags.map((tag) => tag.tagId),
    recentCommands: recent,
    policyStatus,
    // 课表档案（贡献者：威廉）：设备经轮询上报的本地课表快照与存档状态。
    timetable,
    timetableStatus,
  };
});