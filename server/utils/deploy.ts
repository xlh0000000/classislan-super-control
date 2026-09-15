import type Database from "better-sqlite3";
import { configurationSection } from "../../shared/schemas";
import { nowIso } from "./database";
import { PolicyError, publishPolicy } from "./policy";
import { appendAuditWithin } from "./security";
import type { ScopeUser } from "./scope";

/** 下发目标：全校、组织子树、标签或显式设备。 */
export type DeployTarget =
  | { type: "school" }
  | { type: "organization"; id: string }
  | { type: "tag"; id: string }
  | { type: "device"; id: string };

export type ConfigurationDeployInput = {
  configurationId: string;
  targets: DeployTarget[];
  priority?: number;
};

export type ConfigurationDeployTargetResult = {
  scopeType: DeployTarget["type"];
  scopeId: string | null;
  revision: number;
  deviceCount: number;
  replacedSection: boolean;
};

export type ConfigurationDeployResult = {
  configurationId: string;
  name: string;
  section: string;
  deviceCount: number;
  targets: ConfigurationDeployTargetResult[];
};

/** 目标作用域解析出的设备集合（未去重，由调用方合并）。 */
function deviceIdsForTarget(db: Database.Database, target: DeployTarget): string[] {
  const query = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).all(...params) as { id: string }[]).map((row) => row.id);
  if (target.type === "school")
    return query("SELECT id FROM devices WHERE disabled_at IS NULL");
  if (target.type === "device")
    return query("SELECT id FROM devices WHERE id=? AND disabled_at IS NULL", target.id);
  if (target.type === "tag")
    return query("SELECT d.id id FROM device_tags dt JOIN devices d ON d.id=dt.device_id WHERE dt.tag_id=? AND d.disabled_at IS NULL", target.id);
  const node = db.prepare("SELECT path FROM org_nodes WHERE id=?").get(target.id) as { path: string } | undefined;
  if (!node) return [];
  const prefix = node.path === "/" ? "/%" : `${node.path}/%`;
  return query("SELECT d.id id FROM devices d JOIN org_nodes o ON o.id=d.org_node_id WHERE d.disabled_at IS NULL AND (o.path=? OR o.path LIKE ?)", node.path, prefix);
}

/**
 * 把配置库中的一个配置下发到选定目标：在目标作用域发布一份引用该配置的策略修订。
 *
 * - 复用策略层的合并语义：只替换目标作用域中的对应顶层节，其余节、优先级与锁定路径原样保留；
 * - 整个下发是一个事务：任一目标越权、目标不存在或并发冲突时全部回滚，不留半成品；
 * - 设备级作用域优先级最高（school < organization < tag < device），因此被选中的设备
 *   在下一次轮询即收到该配置，无需额外通道。
 */
export function deployConfiguration(
  db: Database.Database,
  input: ConfigurationDeployInput,
  actor: ScopeUser,
  now = nowIso(),
): ConfigurationDeployResult {
  const configuration = db.prepare(`SELECT c.kind kind,c.name name,cr.revision revision
    FROM configurations c JOIN configuration_revisions cr ON cr.id=c.current_revision_id
    WHERE c.id=?`).get(input.configurationId) as { kind: string; name: string; revision: number } | undefined;
  if (!configuration) throw new PolicyError("配置不存在或没有可用修订。", 404);
  const section = configurationSection(configuration.kind);
  if (!section) throw new PolicyError(`配置类型 ${configuration.kind} 不支持下发。`, 400);
  const deploy = db.transaction(() => {
    const seen = new Set<string>();
    const affected = new Set<string>();
    const targets: ConfigurationDeployTargetResult[] = [];
    for (const target of input.targets) {
      const scopeId = target.type === "school" ? null : target.id;
      const scopeKey = `${target.type}:${scopeId ?? ""}`;
      if (seen.has(scopeKey)) continue;
      seen.add(scopeKey);
      // 目标存在性在写入前显式校验，避免发布出永远不会生效的孤儿策略。
      const targetTable = target.type === "device" ? "devices" : target.type === "tag" ? "tags" : target.type === "organization" ? "org_nodes" : null;
      if (targetTable && !db.prepare(`SELECT 1 FROM ${targetTable} WHERE id=?`).get(scopeId!))
        throw new PolicyError(target.type === "device" ? "目标设备不存在。" : target.type === "tag" ? "目标标签不存在。" : "目标组织不存在。", 404);
      const active = db.prepare(`SELECT pa.priority priority,pa.locks locks,pr.revision revision,pr.document document
        FROM policy_assignments pa JOIN policy_revisions pr ON pr.id=pa.policy_revision_id
        WHERE pa.superseded_at IS NULL AND pa.scope_type=? AND pa.scope_key=?`)
        .get(target.type, scopeId ?? "") as { priority: number; locks: string; revision: number; document: string } | undefined;
      const document = { ...(active ? (JSON.parse(active.document) as Record<string, unknown>) : {}) };
      const replacedSection = Object.hasOwn(document, section);
      document[section] = { $config: input.configurationId };
      const published = publishPolicy(db, {
        name: `下发 ${configuration.name}`,
        document,
        scopeType: target.type,
        scopeId,
        priority: active?.priority ?? input.priority ?? 0,
        locks: active ? (JSON.parse(active.locks) as string[]) : [],
        // 显式声明基线修订：并发下发同一作用域时以 409 冲突收场，而不是静默覆盖。
        baseRevision: active?.revision ?? 0,
      }, actor, now);
      const deviceIds = deviceIdsForTarget(db, target);
      for (const deviceId of deviceIds) affected.add(deviceId);
      targets.push({ scopeType: target.type, scopeId, revision: published.revision, deviceCount: deviceIds.length, replacedSection });
    }
    appendAuditWithin(db, {
      actorType: "user", actorId: actor.id, action: "configuration.deploy", targetType: "configuration", targetId: input.configurationId,
      summary: `下发配置 ${configuration.name} 至 ${targets.length} 个目标（${affected.size} 台设备）`,
      details: {
        section,
        configurationRevision: configuration.revision,
        deviceCount: affected.size,
        targets: targets.map(({ scopeType, scopeId, revision, deviceCount }) => ({ scopeType, scopeId, revision, deviceCount })),
      },
    });
    return { configurationId: input.configurationId, name: configuration.name, section, deviceCount: affected.size, targets };
  });
  return deploy();
}