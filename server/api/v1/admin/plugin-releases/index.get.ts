import { comparePluginVersions, resolvePluginUpdateTarget } from "../../../../utils/plugin-updates";
import { pluginUpstreamView } from "../../../../utils/plugin-upstream";
import { pluginUpdateTargetsInView, pluginReleasesWithDistribution } from "../../../../utils/plugin-release-views";
import { deviceScopeFilter, type ScopeUser } from "../../../../utils/scope";

export default defineEventHandler(async (event) => {
  const user = event.context.user as ScopeUser;
  requirePermission(user, "plugins.read");
  const db = useDatabase();
  const filter = deviceScopeFilter(db, user, "d");
  const devices = db.prepare(`SELECT d.id,d.name,d.plugin_version pluginVersion,d.plugin_update_state updateState,d.plugin_update_version updateVersion,
      d.last_seen_at lastSeenAt,d.disabled_at disabledAt
    FROM devices d WHERE ${filter.sql} ORDER BY d.name`).all(...filter.params) as {
    id: string; name: string; pluginVersion: string; updateState: string; updateVersion: string; lastSeenAt: string | null; disabledAt: string | null;
  }[];
  const rows = devices.map((device) => {
    const target = resolvePluginUpdateTarget(db, device.id);
    return {
      ...device,
      targetVersion: target?.version ?? null,
      // 目标来自哪一层要一起给，否则「这台为什么被点名升级」在界面上没法解释。
      targetScope: target ? `${target.scopeType}${target.scopeId ? `:${target.scopeId}` : ""}` : null,
      pending: !!target && comparePluginVersions(target.version, device.pluginVersion) !== 0,
    };
  });
  return {
    releases: pluginReleasesWithDistribution(db, devices.map((device) => ({ id: device.id, pluginVersion: device.pluginVersion }))),
    targets: pluginUpdateTargetsInView(db, user),
    devices: rows,
    // 上游那份结果只是提示，不进设备分布的计算，组织管理员也同样只看得到它。
    upstream: pluginUpstreamView(db),
  };
});
