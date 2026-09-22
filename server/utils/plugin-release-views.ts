import type Database from "better-sqlite3";
import { comparePluginVersions, pluginUpdateTargets, resolvePluginUpdateTarget } from "./plugin-updates";
import { deviceScopeFilter, visibleOrgNodeIds, type ScopeUser } from "./scope";
import { pluginReleaseExists } from "./plugin-release-store";

export type PluginReleaseRow = {
  version: string; fileName: string; sizeBytes: number; sha256: string;
  isCurrent: boolean; createdAt: string; createdBy: string | null;
};

export type PluginReleaseView = PluginReleaseRow & {
  installedCount: number;
  stagedCount: number;
  failedCount: number;
  pendingCount: number;
  filePresent: boolean;
};

/** 按生效目标把设备归类：界面要能回答「有多少台还没升上去、有多少台在等没课重启」。 */
export function pluginReleasesWithDistribution(db: Database.Database, deviceIdentities: { id: string; pluginVersion: string }[]): PluginReleaseView[] {
  const releases = db.prepare(`SELECT r.version,r.file_name fileName,r.size_bytes sizeBytes,r.sha256,r.is_current isCurrent,r.created_at createdAt,u.display_name createdBy
    FROM plugin_releases r LEFT JOIN users u ON u.id=r.created_by`).all() as (Omit<PluginReleaseRow, "isCurrent"> & { isCurrent: number })[];
  const pending = new Map<string, number>();
  for (const device of deviceIdentities) {
    const target = resolvePluginUpdateTarget(db, device.id);
    if (!target || comparePluginVersions(target.version, device.pluginVersion) === 0) continue;
    pending.set(target.version, (pending.get(target.version) ?? 0) + 1);
  }
  const countBy = (column: string, state: string) => {
    const rows = db.prepare(`SELECT ${column} version,COUNT(*) count FROM devices WHERE plugin_update_state=? AND disabled_at IS NULL GROUP BY ${column}`)
      .all(state) as { version: string; count: number }[];
    return new Map(rows.map((row) => [row.version, row.count]));
  };
  const staged = countBy("plugin_update_version", "staged");
  const failed = countBy("plugin_update_version", "failed");
  const installed = new Map((db.prepare("SELECT plugin_version version,COUNT(*) count FROM devices WHERE disabled_at IS NULL GROUP BY plugin_version").all() as { version: string; count: number }[])
    .map((row) => [row.version, row.count]));
  return releases
    .map((release) => ({
      ...release,
      isCurrent: release.isCurrent === 1,
      installedCount: installed.get(release.version) ?? 0,
      stagedCount: staged.get(release.version) ?? 0,
      failedCount: failed.get(release.version) ?? 0,
      pendingCount: pending.get(release.version) ?? 0,
      filePresent: pluginReleaseExists(release.version),
    }))
    .sort((a, b) => comparePluginVersions(b.version, a.version));
}

export type PluginTargetView = { scopeType: string; scopeId: string | null; version: string; updatedAt: string; scopeName: string };

/** 目标列表按用户可见范围收敛：组织外的行与看不见的设备都不外泄，越权探测得不到「存在与否」。 */
export function pluginUpdateTargetsInView(db: Database.Database, user: ScopeUser): PluginTargetView[] {
  const orgNames = new Map((db.prepare("SELECT id,name FROM org_nodes").all() as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  const tagNames = new Map((db.prepare("SELECT id,name FROM tags").all() as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  const filter = deviceScopeFilter(db, user, "d");
  const devices = db.prepare(`SELECT d.id,d.name FROM devices d WHERE ${filter.sql}`).all(...filter.params) as { id: string; name: string }[];
  const deviceNames = new Map(devices.map((row) => [row.id, row.name]));
  const visibleOrgs = visibleOrgNodeIds(db, user);
  const schoolWide = visibleOrgs === null;
  const rank: Record<string, number> = { device: 0, tag: 1, organization: 2, school: 3 };
  return pluginUpdateTargets(db)
    .filter((row) => {
      if (row.scopeType === "school" || row.scopeType === "tag") return schoolWide;
      if (row.scopeType === "organization") return visibleOrgs === null || visibleOrgs.includes(row.scopeId ?? "");
      return deviceNames.has(row.scopeId ?? "");
    })
    .sort((a, b) => (rank[a.scopeType] ?? 9) - (rank[b.scopeType] ?? 9) || a.updatedAt.localeCompare(b.updatedAt))
    .map((row) => ({
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      version: row.version,
      updatedAt: row.updatedAt,
      // 目标挂在的对象上，名字只有一份来源；查不到说明它已被删除，保留行也只报「已删除」。
      scopeName: row.scopeType === "school" ? "全校"
        : row.scopeType === "organization" ? orgNames.get(row.scopeId ?? "") ?? "已删除的组织"
          : row.scopeType === "tag" ? tagNames.get(row.scopeId ?? "") ?? "已删除的标签"
            : deviceNames.get(row.scopeId ?? "") ?? "已注销的设备",
    }));
}
