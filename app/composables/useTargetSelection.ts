export type DeployTargetInput =
  | { type: "school" }
  | { type: "organization"; id: string }
  | { type: "tag"; id: string }
  | { type: "device"; id: string };

export type TargetDevice = {
  id: string; name: string; orgNodeId: string | null; orgName: string; tagIds: string[];
  online: boolean; disabled: boolean;
};

export type TargetOrgNode = { id: string; parentId: string | null; name: string; path: string; sortOrder: number };
export type TargetTag = { id: string; name: string; color: string };

export type TargetSelection = {
  school: boolean;
  orgNodeIds: string[];
  tagIds: string[];
  deviceIds: string[];
};

/**
 * 全局目标选择：楼栋看板与「选择目标」弹窗写入，各个操作面板读取。
 * 选择结果是“组织子树 ∪ 标签 ∪ 显式设备”，另外可叠加全校。
 */
export function useTargetSelection() {
  const selection = useState<TargetSelection>("cic-target-selection", () => ({ school: false, orgNodeIds: [], tagIds: [], deviceIds: [] }));
  const { data: devices } = useFetch<TargetDevice[]>("/api/v1/admin/devices", { key: "cic-target-devices", default: () => [] });
  const { data: org } = useFetch<{ nodes: TargetOrgNode[]; tags: TargetTag[] }>("/api/v1/admin/organization", {
    key: "cic-target-org",
    default: () => ({ nodes: [], tags: [] }),
  });

  const enabledDevices = computed(() => devices.value.filter((device) => !device.disabled));

  /** 组织节点自身 + 全部后代 id。 */
  function subtreeIds(rootIds: string[]): Set<string> {
    const roots = new Set(rootIds);
    const prefixes = org.value.nodes.filter((node) => roots.has(node.id)).map((node) => (node.path === "/" ? "/" : `${node.path}/`));
    const ids = new Set<string>();
    for (const node of org.value.nodes)
      if (roots.has(node.id) || prefixes.some((prefix) => prefix === "/" || node.path.startsWith(prefix))) ids.add(node.id);
    return ids;
  }

  const deviceIds = computed(() => {
    const ids = new Set<string>();
    if (selection.value.school) for (const device of enabledDevices.value) ids.add(device.id);
    const subtree = subtreeIds(selection.value.orgNodeIds);
    const tags = new Set(selection.value.tagIds);
    for (const device of enabledDevices.value) {
      if (device.orgNodeId && subtree.has(device.orgNodeId)) ids.add(device.id);
      if (device.tagIds.some((tagId) => tags.has(tagId))) ids.add(device.id);
    }
    for (const id of selection.value.deviceIds) ids.add(id);
    return [...ids].sort();
  });

  const targets = computed<DeployTargetInput[]>(() => {
    const list: DeployTargetInput[] = [];
    if (selection.value.school) list.push({ type: "school" });
    for (const id of selection.value.orgNodeIds) list.push({ type: "organization", id });
    for (const id of selection.value.tagIds) list.push({ type: "tag", id });
    for (const id of selection.value.deviceIds) list.push({ type: "device", id });
    return list;
  });

  const count = computed(() => deviceIds.value.length);
  const empty = computed(() => targets.value.length === 0);
  const scopes = computed(() => {
    const parts: string[] = [];
    if (selection.value.school) parts.push("全校");
    if (selection.value.orgNodeIds.length) parts.push(`${selection.value.orgNodeIds.length} 个组织`);
    if (selection.value.tagIds.length) parts.push(`${selection.value.tagIds.length} 个标签`);
    if (selection.value.deviceIds.length) parts.push(`${selection.value.deviceIds.length} 台设备`);
    return parts;
  });
  const summary = computed(() => (scopes.value.length ? scopes.value.join(" + ") : "未选择目标"));

  function update(patch: Partial<TargetSelection>) { selection.value = { ...selection.value, ...patch }; }
  function toggle(key: "orgNodeIds" | "tagIds" | "deviceIds", id: string) {
    const current = selection.value[key];
    update({ [key]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] } as Partial<TargetSelection>);
  }
  function toggleSchool() { update({ school: !selection.value.school }); }
  function toggleOrg(id: string) { toggle("orgNodeIds", id); }
  function toggleTag(id: string) { toggle("tagIds", id); }
  function toggleDevice(id: string) { toggle("deviceIds", id); }
  function clear() { selection.value = { school: false, orgNodeIds: [], tagIds: [], deviceIds: [] }; }
  /** 单目标操作（策略发布等）需要一个确定性作用域时用它。 */
  function singleTarget(): DeployTargetInput | null {
    return targets.value.length === 1 ? targets.value[0]! : null;
  }

  const STORAGE_KEY = "classisland-control-targets";
  /** 由外壳布局在挂载时调用：刷新或整页跳转后恢复目标选择。 */
  function restore() {
    if (!import.meta.client) return;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<TargetSelection>;
      selection.value = {
        school: parsed.school === true,
        orgNodeIds: Array.isArray(parsed.orgNodeIds) ? parsed.orgNodeIds : [],
        tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds : [],
        deviceIds: Array.isArray(parsed.deviceIds) ? parsed.deviceIds : [],
      };
    } catch { /* 缓存损坏时按未选择处理 */ }
  }
  function persist() {
    if (!import.meta.client) return;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection.value)); } catch { /* 隐私模式下忽略 */ }
  }

  return {
    selection, devices, org, enabledDevices, deviceIds, targets, count, empty, scopes, summary,
    subtreeIds, toggleSchool, toggleOrg, toggleTag, toggleDevice, clear, singleTarget, restore, persist,
  };
}