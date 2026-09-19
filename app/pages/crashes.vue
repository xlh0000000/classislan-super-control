<script setup lang="ts">
type CrashStats = {
  total: number; last24h: number; last7d: number; devices: number; latestAt: string | null;
  series: { day: string; count: number }[];
  topDevices: { deviceId: string; deviceName: string; count: number; lastSeenAt: string }[];
};
type CrashGroup = {
  fingerprint: string; exceptionType: string; kind: string; count: number; deviceCount: number;
  firstSeenAt: string; lastSeenAt: string; appVersions: string[];
};
type CrashReport = {
  id: string; deviceId: string; deviceName: string; occurredAt: string; kind: string;
  exceptionType: string; message: string; stackTrace: string; appVersion: string;
  pluginVersion: string; platform: string; threadName: string;
};
type CrashPayload = { stats: CrashStats; groups: CrashGroup[] };

const empty = (): CrashPayload => ({
  stats: { total: 0, last24h: 0, last7d: 0, devices: 0, latestAt: null, series: [], topDevices: [] },
  groups: [],
});

const toast = useToast();
const days = ref(14);
// 支持从设备详情深链过来：/crashes?deviceId=<id> 直接按该设备筛选。
const route = useRoute();
const deviceId = ref<string | null>(typeof route.query.deviceId === "string" ? route.query.deviceId : null);
const query = computed(() => ({
  days: days.value,
  ...(deviceId.value ? { deviceId: deviceId.value } : {}),
  // 服务端按“UTC 偏移分钟数”归自然日，getTimezoneOffset() 正是这个值（东八区为 -480）。
  tzOffsetMinutes: new Date().getTimezoneOffset(),
}));
const { data, error, refresh, pending } = await useFetch<CrashPayload>("/api/v1/admin/crashes", {
  query, default: empty,
});
const stats = computed(() => data.value?.stats ?? empty().stats);
const groups = computed(() => data.value?.groups ?? []);
/** 服务端返回的时间一律是 UTC；这里只做确定性裁剪，避免 SSR 与客户端格式化不一致。 */
const stamp = (value: string | null) => (value ? `${value.slice(5, 16).replace("T", " ")} UTC` : "—");
const failure = (err: unknown) =>
  (err as { data?: { message?: string } })?.data?.message ?? (err as Error)?.message ?? "请求失败";
// 加载失败只走土司，不在页面里堆提示元素。
watch(error, (value) => {
  if (value && import.meta.client) toast.err(`崩溃统计加载失败：${failure(value)}`);
});

const active = ref<CrashGroup | null>(null);
const reports = ref<CrashReport[]>([]);
const loadingReports = ref(false);
const reportLimit = 50;

async function openGroup(group: CrashGroup) {
  active.value = group;
  reports.value = [];
  loadingReports.value = true;
  try {
    const result = await $fetch<{ reports: CrashReport[] }>("/api/v1/admin/crashes/reports", {
      query: { fingerprint: group.fingerprint, days: days.value, limit: reportLimit },
    });
    reports.value = result.reports;
  } catch (err) {
    toast.err(`崩溃明细加载失败：${failure(err)}`);
  } finally {
    loadingReports.value = false;
  }
}

/** 破坏性操作统一走二次确认弹窗，清除成功后再由土司反馈。 */
const pendingClear = ref<{ title: string; description: string; body: Record<string, string> } | null>(null);
const confirmBusy = ref(false);

function askClearGroup(group: CrashGroup) {
  pendingClear.value = {
    title: "清除该分组",
    description: `删除「${group.exceptionType}」的 ${group.count} 条记录？还会记进操作记录。`,
    body: { fingerprint: group.fingerprint },
  };
}

function askClearAll() {
  if (!stats.value.total) return;
  pendingClear.value = {
    title: "清除崩溃记录",
    description: deviceId.value
      ? `删除当前设备筛选下的 ${stats.value.total} 条记录？还会记进操作记录。`
      : `删除全部 ${stats.value.total} 条崩溃记录？还会记进操作记录。`,
    body: deviceId.value ? { deviceId: deviceId.value } : {},
  };
}

async function runClear() {
  const task = pendingClear.value;
  if (!task) return;
  confirmBusy.value = true;
  try {
    await $fetch("/api/v1/admin/crashes/clear", {
      method: "POST", headers: { origin: location.origin }, body: task.body,
    });
    toast.ok("崩溃记录已清除。");
    pendingClear.value = null;
    active.value = null;
    await refresh();
  } catch (err) {
    toast.err(`清除失败：${failure(err)}`);
  } finally {
    confirmBusy.value = false;
  }
}

const peak = computed(() => Math.max(1, ...stats.value.series.map((point) => point.count)));
</script>

<template>
  <PageHeading kicker="客户端报错统计" title="崩溃记录">
    <button v-if="deviceId" type="button" class="ghost" @click="deviceId = null">
      只看 {{ stats.topDevices.find((item) => item.deviceId === deviceId)?.deviceName ?? deviceId.slice(0, 8) }} ✕
    </button>
    <button type="button" class="ghost" :disabled="pending" @click="refresh()">{{ pending ? "刷新中…" : "刷新" }}</button>
    <button type="button" class="ghost danger" :disabled="!stats.total" @click="askClearAll">清除记录</button>
  </PageHeading>

  <div class="toolbar">
    <div class="seg">
      <button v-for="option in [7, 14, 30, 90]" :key="option" type="button" :data-active="days === option ? 'true' : 'false'" @click="days = option">{{ option }} 天</button>
    </div>
    <span class="micro">未处理异常按指纹归组</span>
  </div>

  <section class="metrics">
    <MetricTile :label="`最近 ${days} 天`" :value="stats.total" :tone="stats.total ? 'critical' : 'good'" />
    <MetricTile label="近 24 小时" :value="stats.last24h" :tone="stats.last24h ? 'warning' : 'good'" />
    <MetricTile label="涉及设备" :value="stats.devices" />
    <MetricTile label="最近一次" :value="stats.latestAt ? stats.latestAt.slice(5, 16).replace('T', ' ') : '—'" />
  </section>

  <section class="panels">
    <div class="panel">
      <header class="panel-head"><h2>按指纹归组</h2><span class="micro">{{ groups.length }} 组</span></header>
      <EmptyState v-if="!groups.length" title="没有崩溃记录" />
      <ul v-else class="list groups">
        <li v-for="group in groups" :key="group.fingerprint" @click="openGroup(group)">
          <div class="row-main">
            <strong>{{ group.exceptionType }}</strong>
            <small>{{ labelOf(CRASH_KIND_LABELS, group.kind) }} · 最近 {{ stamp(group.lastSeenAt) }}</small>
          </div>
          <div class="count"><b>{{ group.count }}</b><small>{{ group.deviceCount }} 台</small></div>
        </li>
      </ul>
    </div>

    <aside>
      <div class="panel">
        <header class="panel-head"><h2>趋势</h2></header>
        <div class="series">
          <span v-for="point in stats.series" :key="point.day" :title="`${point.day} · ${point.count} 条`" :data-empty="point.count === 0" :style="{ height: `${Math.round((point.count / peak) * 100)}%` }" />
        </div>
        <p class="note">{{ stats.series.length ? `${stats.series[0]?.day} 起 · 每列一天 · 峰值 ${peak} 条` : "暂无数据" }}</p>
      </div>

      <div class="panel">
        <header class="panel-head"><h2>崩溃最多的设备</h2></header>
        <EmptyState v-if="!stats.topDevices.length" title="还没有设备上报" />
        <ul v-else class="list devices">
          <li v-for="item in stats.topDevices" :key="item.deviceId" @click="deviceId = item.deviceId">
            <div class="row-main">
              <strong>{{ item.deviceName || item.deviceId.slice(0, 8) }}</strong>
              <small>{{ item.count }} 条 · {{ stamp(item.lastSeenAt) }}</small>
            </div>
            <i class="arrow">→</i>
          </li>
        </ul>
      </div>
    </aside>
  </section>

  <AppDialog v-if="active" kicker="崩溃分组" :title="active.exceptionType" width="900px" @close="active = null">
    <dl class="meta">
      <div><dt>特征码</dt><dd><code>{{ active.fingerprint }}</code></dd></div>
      <div><dt>类型</dt><dd>{{ labelOf(CRASH_KIND_LABELS, active.kind) }}</dd></div>
      <div><dt>次数</dt><dd>{{ active.count }} 条 · {{ active.deviceCount }} 台设备</dd></div>
      <div><dt>应用版本</dt><dd>{{ active.appVersions.join("、") || "—" }}</dd></div>
      <div><dt>首次出现</dt><dd>{{ stamp(active.firstSeenAt) }}</dd></div>
      <div><dt>最近一次</dt><dd>{{ stamp(active.lastSeenAt) }}</dd></div>
    </dl>

    <p v-if="loadingReports" class="note">正在加载明细…</p>
    <p v-else-if="!reports.length" class="note">没有该分组的明细。</p>
    <div v-else class="reports">
      <article v-for="report in reports" :key="report.id">
        <header>
          <strong>{{ report.deviceName || report.deviceId.slice(0, 8) }}</strong>
          <span>{{ stamp(report.occurredAt) }} · 插件 {{ report.pluginVersion }} · 应用 {{ report.appVersion }} · {{ report.platform }}<template v-if="report.threadName"> · {{ report.threadName }}</template></span>
        </header>
        <p>{{ report.message || "（无消息）" }}</p>
        <pre>{{ report.stackTrace || "（无堆栈）" }}</pre>
      </article>
    </div>
    <p v-if="reports.length >= reportLimit" class="note">只显示最近 {{ reportLimit }} 条。</p>

    <template #footer>
      <button type="button" class="danger" @click="askClearGroup(active)">清除该分组</button>
      <button type="button" @click="active = null">关闭</button>
    </template>
  </AppDialog>

  <ConfirmDialog
    v-if="pendingClear"
    :title="pendingClear.title"
    :description="pendingClear.description"
    confirm-text="清除"
    danger
    :busy="confirmBusy"
    @close="pendingClear = null"
    @confirm="runClear"
  />
</template><style scoped>
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; }
.panels { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; }
aside { display: grid; gap: 14px; align-content: start; }
.panel .list { margin-top: 18px; }
.groups li { cursor: pointer; }
.count { display: grid; gap: 4px; justify-items: end; flex: none; }
.count b { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.count small { color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.series { display: flex; align-items: flex-end; gap: 3px; height: 100px; margin-top: 22px; }
.series span { flex: 1; min-height: 2px; background: var(--accent); }
.series span[data-empty="true"] { background: var(--surface-3); }
.note { margin: 14px 0 0; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.5px; }
.devices li { cursor: pointer; }
.devices .arrow { color: var(--ink-faint); font-style: normal; }
/* RhineLab .metadata：11px 说明 + 17px 取值，两列。 */
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 22px 40px; margin: 0; }
.meta dt { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; }
.meta dd { margin: 8px 0 0; font-size: 15px; word-break: break-all; }
.meta code { font-family: ui-monospace, monospace; font-size: 13px; }
.reports { display: grid; gap: 0; margin-top: 22px; border-top: 1px solid var(--line-strong); }
.reports article { padding: 18px 2px; border-bottom: 1px solid var(--line-soft); }
.reports header { display: grid; gap: 6px; }
.reports header strong { font-size: 14px; font-weight: 600; }
.reports header span { color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.reports p { margin: 12px 0 0; font-size: 13px; }
.reports pre {
  margin: 12px 0 0;
  padding: 14px 16px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--line);
  background: var(--surface-2);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 1080px) { .panels { grid-template-columns: 1fr; } .meta { grid-template-columns: 1fr; } }
</style>