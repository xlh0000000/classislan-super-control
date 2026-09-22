<script setup lang="ts">
import {
  MAX_PLUGIN_RELEASE_BYTES,
  PLUGIN_UPSTREAM_MAX_INTERVAL_MINUTES,
  PLUGIN_UPSTREAM_MIN_INTERVAL_MINUTES,
  pluginProxyPrefixError,
  type PluginUpdateTargetInput,
} from "#shared/schemas";

type ScopeType = "school" | "organization" | "tag" | "device";
type Release = {
  version: string; fileName: string; sizeBytes: number; sha256: string; isCurrent: boolean;
  createdAt: string; createdBy: string | null;
  installedCount: number; stagedCount: number; failedCount: number; pendingCount: number; filePresent: boolean;
};
type Target = { scopeType: ScopeType; scopeId: string | null; version: string; updatedAt: string; scopeName: string };
type DeviceRow = {
  id: string; name: string; pluginVersion: string; updateState: string; updateVersion: string;
  targetVersion: string | null; targetScope: string | null; pending: boolean; lastSeenAt: string | null; disabledAt: string | null;
};
type UpstreamConfig = { enabled: boolean; repo: string; proxies: string[]; intervalMinutes: number };
type UpstreamState = {
  checkedAt: string; ok: boolean; version: string | null; tagName: string | null; assetName: string | null;
  sha256: string | null; sizeBytes: number | null; via: "proxy" | "direct" | null; error: string | null;
};
type Upstream = {
  config: UpstreamConfig; state: UpstreamState | null; newestInstalled: string | null;
  currentVersion: string | null; hasUpdate: boolean; imported: boolean;
};
type ReleasePayload = { releases: Release[]; targets: Target[]; devices: DeviceRow[]; upstream: Upstream };
type OrgData = { nodes: { id: string; name: string; path: string }[]; tags: { id: string; name: string }[] };

const NO_UPSTREAM: Upstream = {
  config: { enabled: false, repo: "", proxies: [], intervalMinutes: PLUGIN_UPSTREAM_MIN_INTERVAL_MINUTES },
  state: null, newestInstalled: null, currentVersion: null, hasUpdate: false, imported: false,
};

const empty = (): ReleasePayload => ({ releases: [], targets: [], devices: [], upstream: NO_UPSTREAM });

const toast = useToast();
const { user, can } = useSession();
const canManage = computed(() => can("plugins.write"));
// 上传、设为当前、撤回都会改写全校的默认目标，组织管理员做不到，入口直接收起。
const schoolWide = computed(() => !user.value?.scopeOrgNodeId);
const canPublish = computed(() => canManage.value && schoolWide.value);

const { data, error, refresh, pending } = await useFetch<ReleasePayload>("/api/v1/admin/plugin-releases", {
  default: empty,
});
const { data: org } = await useFetch<OrgData>("/api/v1/admin/organization", { default: () => ({ nodes: [], tags: [] }) });
watch(error, (value) => {
  if (value && import.meta.client) toast.err(`插件版本信息加载失败：${failure(value)}`);
});

const releases = computed(() => data.value.releases);
const targets = computed(() => data.value.targets);
const devices = computed(() => data.value.devices);
const current = computed(() => releases.value.find((release) => release.isCurrent) ?? null);
const tab = ref("releases");
const tabs = [
  { key: "releases", label: "发布版本" },
  { key: "targets", label: "目标版本" },
  { key: "devices", label: "逐台设备" },
];

/** 等重启与失败都只算还在升级途中的机器。 */
const waiting = computed(() => releases.value.reduce((sum, release) => sum + release.stagedCount, 0));
const failing = computed(() => releases.value.reduce((sum, release) => sum + release.failedCount, 0));
const behind = computed(() => devices.value.filter((device) => device.pending && !device.disabledAt).length);

const upstream = computed(() => data.value.upstream ?? NO_UPSTREAM);
const upstreamState = computed(() => upstream.value.state);
const upstreamNote = computed(() => {
  if (!upstream.value.config.enabled) return "检测已关闭";
  const state = upstreamState.value;
  if (!state) return "还没有检查过";
  if (!state.ok) return state.error ?? "上次检查没成功";
  if (!upstream.value.newestInstalled) return "库里还没有包";
  return upstream.value.hasUpdate ? `库内最新 ${upstream.value.newestInstalled}` : upstream.value.imported ? "包已在库中" : "与库内版本一致";
});
const upstreamTone = computed(() => {
  if (!upstream.value.config.enabled) return "normal" as const;
  const state = upstreamState.value;
  if (!state) return "normal" as const;
  return state.ok ? (upstream.value.hasUpdate ? "warning" as const : "good" as const) : "critical" as const;
});
const upstreamHeadline = computed(() => {
  if (!upstream.value.config.enabled) return "上游版本检测已关闭。";
  const state = upstreamState.value;
  if (!state) return "还没有检查过上游版本。";
  if (!state.ok) return `上次检查没成功：${state.error ?? "上游没有给出可读的版本信息"}`;
  if (!upstream.value.hasUpdate) return `上游最新 ${state.version}，与库内一致。`;
  return upstream.value.newestInstalled
    ? `上游最新 ${state.version}，比库内最新的 ${upstream.value.newestInstalled} 新。`
    : `上游最新 ${state.version}，库里还没有任何发布版本。`;
});
const upstreamVia = computed(() => {
  const state = upstreamState.value;
  if (!state?.ok) return "";
  return `${state.via === "proxy" ? "经镜像取回" : "直连 github"} · 标签 ${state.tagName} · 包 ${state.assetName}${state.sizeBytes ? ` · ${sizeText(state.sizeBytes)}` : ""} · 检查于 ${stamp(state.checkedAt)}`;
});

const upstreamDraft = ref<UpstreamConfig>({ ...upstream.value.config, proxies: [...upstream.value.config.proxies] });
const proxyText = ref(upstream.value.config.proxies.join("\n"));
/** 只在拉取到新的上游信息后回填，避免用户正在编辑的镜像列表被别的操作冲掉。 */
function syncUpstreamDraft() {
  upstreamDraft.value = { ...upstream.value.config, proxies: [...upstream.value.config.proxies] };
  proxyText.value = upstream.value.config.proxies.join("\n");
}

const upstreamBusy = ref<"config" | "check" | null>(null);
/** 逐行给出第一个不合法地址的原因：管理员填的镜像往往只差在 scheme 或域名上。 */
const proxyProblem = computed(() => {
  for (const line of proxyText.value.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    const error = pluginProxyPrefixError(value);
    if (error) return `${value}：${error}`;
  }
  return "";
});

async function saveUpstreamConfig() {
  if (upstreamBusy.value) return;
  const proxies = proxyText.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (proxyProblem.value) return toast.err(`镜像地址有问题 —— ${proxyProblem.value}`);
  upstreamBusy.value = "config";
  try {
    await $fetch("/api/v1/admin/plugin-upstream/config", {
      method: "POST", headers: { origin: location.origin },
      body: { enabled: upstreamDraft.value.enabled, repo: upstreamDraft.value.repo.trim(), proxies, intervalMinutes: upstreamDraft.value.intervalMinutes },
    });
    await refresh();
    syncUpstreamDraft();
    toast.ok("检测设置已保存。");
  } catch (err) {
    toast.err(`保存检测设置失败：${failure(err)}`);
  } finally {
    upstreamBusy.value = null;
  }
}

async function runUpstreamCheck() {
  if (upstreamBusy.value) return;
  upstreamBusy.value = "check";
  try {
    const result = await $fetch<{ upstream: Upstream }>("/api/v1/admin/plugin-upstream/check", {
      method: "POST", headers: { origin: location.origin },
    });
    await refresh();
    syncUpstreamDraft();
    if (result.upstream.state?.ok) toast.ok(`上游最新是 ${result.upstream.state.version}。`);
    else toast.err(`检查失败：${result.upstream.state?.error ?? "上游没有给出可读的版本信息"}`);
  } catch (err) {
    toast.err(`检查失败：${failure(err)}`);
  } finally {
    upstreamBusy.value = null;
  }
}

function askImportUpstream() {
  const version = upstreamState.value?.version;
  if (!version || upstreamBusy.value) return;
  pendingAction.value = {
    title: "拉取上游插件包",
    description: `取回 ${version} 的插件包并存为一个发布版本，不会设为当前版本。`,
    run: async () => {
      await $fetch("/api/v1/admin/plugin-upstream/import", {
        method: "POST", headers: { origin: location.origin }, body: { version },
      });
    },
  };
}

/** 服务端返回的时间一律是 UTC；只做确定性裁剪，避免 SSR 与客户端格式化不一致。 */
function stamp(value: string | null) {
  return value ? `${value.slice(5, 16).replace("T", " ")} UTC` : "—";
}
function sizeText(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
function failure(err: unknown) {
  return (err as { data?: { message?: string } })?.data?.message ?? (err as Error)?.message ?? "请求失败";
}
/** 目标来自哪一层：全校默认就是跟着当前版本走，单独指定的报出那一层的对象名。 */
function targetSource(scope: string | null) {
  if (!scope) return "—";
  const type = scope.split(":")[0];
  if (type === "school") return "全校默认";
  const hit = targets.value.find((target) => `${target.scopeType}:${target.scopeId ?? ""}` === scope);
  const label = labelOf(PLUGIN_SCOPE_LABELS, type);
  return hit ? `${label}指定 · ${hit.scopeName}` : `${label}（已删除）`;
}
function deviceState(device: DeviceRow) {
  if (device.disabledAt) return "已停用";
  if (device.updateState === "failed") return "升级失败";
  if (device.updateState === "staged") return "等没课重启";
  if (device.pending) return "待升级";
  return "已到位";
}
function deviceStateTone(device: DeviceRow) {
  const text = deviceState(device);
  return text === "升级失败" ? "critical" : text === "等没课重启" || text === "待升级" ? "warning" : "good";
}

const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

/** 分块转 base64：一次 String.fromCharCode 摊开 25 MiB 会直接把标签页打爆。 */
async function readAsBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || uploading.value) return;
  if (!file.name.toLowerCase().endsWith(".cipx")) return toast.err("只能上传 .cipx 插件包。");
  if (!file.size || file.size > MAX_PLUGIN_RELEASE_BYTES) return toast.err("插件包大小需在 25 MiB 以内。");
  uploading.value = true;
  try {
    const result = await $fetch<{ version: string }>("/api/v1/admin/plugin-releases", {
      method: "POST", headers: { origin: location.origin },
      body: { fileName: file.name, contentBase64: await readAsBase64(file) },
    });
    await refresh();
    toast.ok(`插件包 ${result.version} 已上传，并成为当前版本。`);
  } catch (err) {
    toast.err(`上传失败：${failure(err)}`);
  } finally {
    uploading.value = false;
  }
}

const pendingAction = ref<{ title: string; description: string; run: () => Promise<void> } | null>(null);
const actionBusy = ref(false);

function askMakeCurrent(release: Release) {
  pendingAction.value = {
    title: "设为当前版本",
    description: `没单独设过目标的设备都会跟着 ${release.version} 走。`,
    run: async () => {
      await $fetch(`/api/v1/admin/plugin-releases/${release.version}/current`, {
        method: "POST", headers: { origin: location.origin },
      });
    },
  };
}

function askRemove(release: Release) {
  pendingAction.value = {
    title: "撤回插件包",
    description: `删除 ${release.version}（${sizeText(release.sizeBytes)}）？已装上这一版的设备不受影响。`,
    run: async () => {
      await $fetch(`/api/v1/admin/plugin-releases/${release.version}`, {
        method: "DELETE", headers: { origin: location.origin },
      });
    },
  };
}

async function runPendingAction() {
  const task = pendingAction.value;
  if (!task) return;
  actionBusy.value = true;
  try {
    await task.run();
    await refresh();
    pendingAction.value = null;
    toast.ok("已更新。");
  } catch (err) {
    toast.err(`操作失败：${failure(err)}`);
  } finally {
    actionBusy.value = false;
  }
}

/** 目标表单：先定作用域，再定版本；没手选过时默认落在这一层已有的版本上，再退到当前版本。 */
const scope = ref<{ type: ScopeType; id: string }>({ type: "school", id: "" });
const pickedVersion = ref("");
const targetBusy = ref(false);
function targetFor(scopeType: ScopeType, scopeId: string | null) {
  return targets.value.find((target) => target.scopeType === scopeType && (target.scopeId ?? null) === scopeId) ?? null;
}
const scopeTarget = computed(() => targetFor(scope.value.type, scope.value.type === "school" ? null : scope.value.id));
const scopeVersion = computed({
  get: () => pickedVersion.value || scopeTarget.value?.version || current.value?.version || "",
  set: (value: string) => { pickedVersion.value = value; },
});
watch(scope, () => { pickedVersion.value = ""; }, { deep: true });

async function saveTarget(cleared = false) {
  if (targetBusy.value) return;
  const { type, id } = scope.value;
  if (type !== "school" && !id) return toast.err("请选择目标对象。");
  const body: PluginUpdateTargetInput = {
    scopeType: type,
    ...(type === "school" ? {} : { scopeId: id }),
    version: cleared ? null : scopeVersion.value || null,
  } as PluginUpdateTargetInput;
  targetBusy.value = true;
  try {
    await $fetch("/api/v1/admin/plugin-targets", { method: "POST", headers: { origin: location.origin }, body });
    await refresh();
    toast.ok(cleared ? "已取消该范围的单独目标，交回上级作用域决定。" : "目标版本已保存，设备在下次联系时开始下载。");
  } catch (err) {
    toast.err(`保存目标失败：${failure(err)}`);
  } finally {
    targetBusy.value = false;
  }
}

function askCancelTarget(target: Target) {
  pendingAction.value = {
    title: "取消目标版本",
    description: `「${target.scopeName}」不再单独指定版本，回落到上级作用域。已经在途的暂存包会被设备丢弃。`,
    run: async () => {
      await $fetch("/api/v1/admin/plugin-targets", {
        method: "POST", headers: { origin: location.origin },
        body: {
          scopeType: target.scopeType,
          ...(target.scopeType === "school" ? {} : { scopeId: target.scopeId }),
          version: null,
        },
      });
    },
  };
}
</script>

<template>
  <PageHeading kicker="设备端插件的发包与升级" title="插件升级">
    <button type="button" class="ghost" :disabled="pending" @click="refresh()">{{ pending ? "刷新中…" : "刷新" }}</button>
    <button v-if="canPublish" type="button" class="solid" :disabled="uploading" @click="fileInput?.click()">
      {{ uploading ? "上传中…" : "上传插件包" }}
    </button>
    <input ref="fileInput" hidden type="file" accept=".cipx,application/zip" @change="pickFile">
  </PageHeading>

  <PageTabs v-model="tab" :items="tabs" />

  <section class="metrics">
    <MetricTile label="当前版本" :value="current?.version ?? '—'" :note="current ? `${current.installedCount} 台已在用` : '还没有上传插件包'" :tone="current ? 'good' : 'warning'" />
    <MetricTile label="已上传版本" :value="releases.length" />
    <MetricTile label="上游版本" :value="upstreamState?.version ?? '—'" :note="upstreamNote" :tone="upstreamTone" />
    <MetricTile label="在途设备" :value="behind" :note="`${waiting} 台在等没课重启`" :tone="behind ? 'warning' : 'good'" />
    <MetricTile label="升级失败" :value="failing" :tone="failing ? 'critical' : 'good'" />
  </section>

  <template v-if="tab === 'releases'">
    <fieldset class="upstream">
      <legend>上游版本检测</legend>
      <div class="head">
        <strong :class="{ warn: upstreamState && !upstreamState.ok }">{{ upstreamHeadline }}</strong>
        <small v-if="upstreamVia">{{ upstreamVia }}</small>
      </div>
      <div v-if="canPublish" class="form">
        <SwitchToggle v-model="upstreamDraft.enabled" label="自动检测" class="switch" />
        <label>检查间隔（分钟）
          <input v-model.number="upstreamDraft.intervalMinutes" type="number" :min="PLUGIN_UPSTREAM_MIN_INTERVAL_MINUTES" :max="PLUGIN_UPSTREAM_MAX_INTERVAL_MINUTES" step="5">
        </label>
        <label>上游仓库
          <input v-model.trim="upstreamDraft.repo" type="text" maxlength="200" placeholder="owner/name">
        </label>
        <label class="wide">镜像地址
          <textarea v-model="proxyText" rows="3" spellcheck="false"></textarea>
          <small>每行一个，按顺序试；都不通时直连 github。</small>
        </label>
      </div>
      <footer>
        <small v-if="proxyProblem" class="warn">镜像地址有问题 —— {{ proxyProblem }}</small>
        <small v-else-if="!canPublish">检测由全校范围的管理员维护。</small>
        <div class="controls">
          <button v-if="canPublish" type="button" :disabled="upstreamBusy !== null" @click="runUpstreamCheck()">
            {{ upstreamBusy === "check" ? "检查中…" : "立即检查" }}
          </button>
          <button v-if="canPublish && upstream.hasUpdate" type="button" class="solid" :disabled="actionBusy" @click="askImportUpstream()">
            拉取 {{ upstreamState?.version }}
          </button>
          <button v-if="canPublish" type="button" class="ghost" :disabled="upstreamBusy !== null" @click="saveUpstreamConfig()">
            {{ upstreamBusy === "config" ? "保存中…" : "保存检测设置" }}
          </button>
        </div>
      </footer>
    </fieldset>

    <EmptyState v-if="!releases.length" title="还没有上传插件包" />
    <div v-else class="table-shell">
      <table>
        <thead><tr><th>版本</th><th>包</th><th>摘要</th><th>已在</th><th>在途</th><th>等重启</th><th>失败</th><th>上传</th><th></th></tr></thead>
        <tbody>
          <tr v-for="release in releases" :key="release.version">
            <td>
              <strong>{{ release.version }}</strong>
              <small v-if="release.isCurrent">当前版本</small>
              <small v-else-if="!release.filePresent" class="warn">包文件缺失</small>
            </td>
            <td><small>{{ release.fileName }} · {{ sizeText(release.sizeBytes) }}</small></td>
            <td><small class="mono">{{ release.sha256.slice(0, 12) }}</small></td>
            <td>{{ release.installedCount }}</td>
            <td>{{ release.pendingCount }}</td>
            <td>{{ release.stagedCount }}</td>
            <td :class="{ critical: release.failedCount }">{{ release.failedCount }}</td>
            <td><small>{{ release.createdBy || "—" }} · {{ stamp(release.createdAt) }}</small></td>
            <td class="row-actions">
              <button v-if="canPublish && !release.isCurrent && release.filePresent" type="button" @click="askMakeCurrent(release)">设为当前</button>
              <button v-if="canPublish && !release.isCurrent" type="button" class="danger" @click="askRemove(release)">撤回</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>

  <template v-else-if="tab === 'targets'">
    <fieldset v-if="canManage" class="target-form">
      <legend>指定目标版本</legend>
      <div class="form">
        <label>作用范围
          <select v-model="scope.type" @change="scope.id = ''">
            <option value="school">全校</option>
            <option value="organization">组织</option>
            <option value="tag">标签</option>
            <option value="device">设备</option>
          </select>
        </label>
        <label v-if="scope.type === 'organization'">目标组织
          <select v-model="scope.id"><option value="">请选择组织</option><option v-for="node in org.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select>
        </label>
        <label v-else-if="scope.type === 'tag'">目标标签
          <select v-model="scope.id"><option value="">请选择标签</option><option v-for="tag in org.tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option></select>
        </label>
        <label v-else-if="scope.type === 'device'">目标设备
          <select v-model="scope.id"><option value="">请选择设备</option><option v-for="device in devices" :key="device.id" :value="device.id">{{ device.name }}</option></select>
        </label>
        <label>目标版本
          <select v-model="scopeVersion">
            <option v-for="release in releases" :key="release.version" :value="release.version">
              {{ release.version }}{{ release.isCurrent ? "（当前）" : "" }}{{ release.filePresent ? "" : "（缺包文件）" }}
            </option>
          </select>
        </label>
      </div>
      <footer>
        <small>{{ scopeTarget
          ? `${scopeTarget.scopeName} 目前指定 ${scopeTarget.version} · ${stamp(scopeTarget.updatedAt)}`
          : '这一层还没单独指定过版本。' }}</small>
        <div class="controls">
          <button type="button" class="ghost" :disabled="targetBusy || !scopeTarget" @click="saveTarget(true)">取消该范围</button>
          <button type="button" class="solid" :disabled="targetBusy || !scopeVersion || !releases.length" @click="saveTarget()">
            {{ targetBusy ? "保存中…" : "保存并下发" }}
          </button>
        </div>
      </footer>
    </fieldset>

    <EmptyState v-if="!targets.length" title="没有设备组被单独指定过版本" />
    <div v-else class="table-shell">
      <table>
        <thead><tr><th>范围</th><th>对象</th><th>目标版本</th><th>设置时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="target in targets" :key="`${target.scopeType}:${target.scopeId ?? ''}`">
            <td>{{ labelOf(PLUGIN_SCOPE_LABELS, target.scopeType) }}</td>
            <td><strong>{{ target.scopeType === "school" ? "全部设备" : target.scopeName }}</strong></td>
            <td>{{ target.version }}</td>
            <td><small>{{ stamp(target.updatedAt) }}</small></td>
            <td class="row-actions">
              <button v-if="canManage" type="button" class="danger" @click="askCancelTarget(target)">取消</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>

  <template v-else>
    <EmptyState v-if="!devices.length" title="还没有设备接入" action="查看接入" to="/enrollment" />
    <div v-else class="table-shell">
      <table>
        <thead><tr><th>设备</th><th>插件版本</th><th>目标版本</th><th>目标来源</th><th>状态</th><th>最后联系</th></tr></thead>
        <tbody>
          <tr v-for="device in devices" :key="device.id">
            <td><strong>{{ device.name }}</strong><small>{{ device.id }}</small></td>
            <td>{{ device.pluginVersion || "—" }}</td>
            <td>{{ device.targetVersion || "—" }}</td>
            <td><small>{{ targetSource(device.targetScope) }}</small></td>
            <td>
              <span class="state" :data-tone="deviceStateTone(device)">{{ deviceState(device) }}</span>
              <small v-if="device.updateState === 'staged' || device.updateState === 'failed'">{{ device.updateVersion }}</small>
            </td>
            <td><small>{{ device.lastSeenAt ? stamp(device.lastSeenAt) : "从未" }}</small></td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>

  <ConfirmDialog
    v-if="pendingAction"
    :title="pendingAction.title"
    :description="pendingAction.description"
    confirm-text="确定"
    :danger="pendingAction.title !== '设为当前版本'"
    :busy="actionBusy"
    @close="pendingAction = null"
    @confirm="runPendingAction"
  />
</template>

<style scoped>
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 14px; }
.table-shell { margin-top: 16px; overflow: auto; border-top: 1px solid var(--line-strong); }
td:first-child { display: grid; gap: 4px; }
td strong { font-size: 14px; font-weight: 600; color: var(--ink); }
td small { display: block; color: var(--ink-faint); font-size: 10px; letter-spacing: 0.5px; }
td small.warn { color: var(--bad); }
td.critical { color: var(--bad); }
.mono { font-family: ui-monospace, monospace; letter-spacing: 0; }
.state { display: inline-flex; align-items: center; gap: 8px; }
.state::before { content: ""; width: 7px; height: 7px; background: var(--ink-faint); }
.state[data-tone="good"]::before { background: var(--good); }
.state[data-tone="warning"]::before { background: var(--warning); }
.state[data-tone="critical"]::before { background: var(--bad); }
.row-actions { text-align: right; white-space: nowrap; }
.row-actions button { min-height: 0; padding: 0 0 3px; border: 0; border-bottom: 1px solid transparent; background: none; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.5px; }
.row-actions button:hover:not(:disabled) { border-bottom-color: var(--accent); background: none; color: var(--accent); }
/* 行内只保留文字按钮，全局 button.danger 的实框样式在这里不适用。 */
.row-actions button.danger:hover:not(:disabled) { border-bottom-color: var(--bad); background: none; color: var(--bad); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
.upstream { margin-bottom: 16px; padding: 22px 24px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.upstream legend { padding: 0 10px; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.upstream .head { display: grid; gap: 6px; }
.upstream .head strong { font-size: 14px; font-weight: 600; color: var(--ink); }
.upstream .head strong.warn { color: var(--bad); }
.upstream .head small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.8px; }
.upstream .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; margin-top: 18px; }
.upstream .form label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.upstream .form input, .upstream .form textarea { width: 100%; }
.upstream .form textarea { padding: 10px 12px; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.8; letter-spacing: 0; resize: vertical; }
.upstream .form label small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.6px; }
.upstream .form .wide { grid-column: 1 / -1; }
.upstream .form .switch { align-self: end; }
.upstream footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.upstream footer > small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.8px; }
.upstream footer small.warn { color: var(--bad); }
.upstream footer div { display: flex; align-items: center; gap: 14px; }
.target-form { padding: 22px 24px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.target-form legend { padding: 0 10px; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.target-form .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; }
.target-form label, .target-form select { display: grid; gap: 8px; width: 100%; }
.target-form label { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.target-form footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.target-form footer small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.8px; }
.target-form footer div { display: flex; align-items: center; gap: 14px; }
</style>
