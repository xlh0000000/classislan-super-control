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
    description: `删除「${group.exceptionType}」的 ${group.count} 条记录？清除动作会写入审计日志。`,
    body: { fingerprint: group.fingerprint },
  };
}

function askClearAll() {
  if (!stats.value.total) return;
  pendingClear.value = {
    title: "清除崩溃记录",
    description: deviceId.value
      ? `删除当前设备筛选下的 ${stats.value.total} 条记录？清除动作会写入审计日志。`
      : `删除全部 ${stats.value.total} 条崩溃记录？清除动作会写入审计日志。`,
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
  <PageHeading
    kicker="CRASH REPORTS / 崩溃统计"
    title="崩溃"
    description="客户端未处理异常按指纹归组；堆栈只在弹窗里展开。"
  >
    <div class="range">
      <button
        v-for="option in [7, 14, 30, 90]"
        :key="option"
        type="button"
        :class="{ active: days === option }"
        @click="days = option"
      >{{ option }} 天</button>
    </div>
    <button v-if="deviceId" type="button" class="ghost" @click="deviceId = null">
      设备筛选：{{ stats.topDevices.find((item) => item.deviceId === deviceId)?.deviceName ?? deviceId.slice(0, 8) }} ✕
    </button>
    <button type="button" class="ghost" :disabled="pending" @click="refresh()">
      {{ pending ? "刷新中…" : "刷新" }}
    </button>
    <button type="button" class="ghost danger" :disabled="!stats.total" @click="askClearAll">清除记录</button>
  </PageHeading>

  <section class="metrics">
    <MetricTile label="崩溃总数" :value="stats.total" :note="`最近 ${days} 天，按指纹归组`"
                :tone="stats.total ? 'critical' : 'good'" />
    <MetricTile label="近 24 小时" :value="stats.last24h" note="含重复崩溃"
                :tone="stats.last24h ? 'warning' : 'good'" />
    <MetricTile label="涉及设备" :value="stats.devices" note="上报过崩溃的设备数" />
    <MetricTile label="最近一次" :value="stats.latestAt ? stats.latestAt.slice(5, 16).replace('T', ' ') : '—'"
                :note="stamp(stats.latestAt)" />
  </section>

  <section class="panels">
    <div class="panel">
      <h2>崩溃分组</h2>
      <EmptyState v-if="!groups.length" title="没有崩溃记录" description="设备上报的未处理异常会出现在这里。" />
      <ul v-else class="groups">
        <li v-for="group in groups" :key="group.fingerprint" @click="openGroup(group)">
          <div>
            <strong>{{ group.exceptionType }}</strong>
            <small>{{ group.kind }} · 最近 {{ stamp(group.lastSeenAt) }}</small>
          </div>
          <div class="count">
            <b>{{ group.count }}</b>
            <small>{{ group.deviceCount }} 台设备</small>
          </div>
        </li>
      </ul>
    </div>

    <aside>
      <div class="panel">
        <h2>趋势</h2>
        <div class="series">
          <span v-for="point in stats.series" :key="point.day"
                :title="`${point.day} · ${point.count} 条`"
                :data-empty="point.count === 0"
                :style="{ height: `${Math.round((point.count / peak) * 100)}%` }" />
        </div>
        <p class="note">{{ stats.series.length ? `${stats.series[0]?.day} 起 · 每列一天 · 峰值 ${peak} 条` : "暂无数据" }}</p>
      </div>

      <div class="panel">
        <h2>崩溃最多的设备</h2>
        <EmptyState v-if="!stats.topDevices.length" title="暂无设备" description="还没有设备上报崩溃。" />
        <ul v-else class="devices">
          <li v-for="item in stats.topDevices" :key="item.deviceId">
            <button type="button" @click="deviceId = item.deviceId">
              <span>{{ item.deviceName || item.deviceId.slice(0, 8) }}</span>
              <small>{{ item.count }} 条 · {{ stamp(item.lastSeenAt) }}</small>
            </button>
          </li>
        </ul>
      </div>
    </aside>
  </section>

  <AppDialog
    v-if="active"
    kicker="CRASH GROUP / 崩溃分组"
    :title="active.exceptionType"
    width="900px"
    @close="active = null"
  >
    <dl class="meta">
      <div><dt>指纹</dt><dd><code>{{ active.fingerprint }}</code></dd></div>
      <div><dt>类型</dt><dd>{{ active.kind }}</dd></div>
      <div><dt>次数</dt><dd>{{ active.count }} 条 · {{ active.deviceCount }} 台设备</dd></div>
      <div><dt>首次 / 最近</dt><dd>{{ stamp(active.firstSeenAt) }} / {{ stamp(active.lastSeenAt) }}</dd></div>
      <div><dt>应用版本</dt><dd>{{ active.appVersions.join("、") || "—" }}</dd></div>
    </dl>

    <p v-if="loadingReports" class="note">正在加载明细…</p>
    <p v-else-if="!reports.length" class="note">没有该分组的明细记录。</p>
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
    <p v-if="reports.length >= reportLimit" class="note">仅显示最近 {{ reportLimit }} 条明细。</p>

    <template #footer>
      <button type="button" class="ghost danger" @click="askClearGroup(active)">清除该分组</button>
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
</template>

<style scoped>
.actions .range{display:flex;gap:4px;padding:3px;border-radius:var(--radius-control);background:var(--surface-1)}
.actions .range button{min-height:38px;padding:0 12px;border:0;border-radius:11px;background:transparent;color:var(--ink-soft);cursor:pointer;font-size:11px}
.actions .range button.active{background:var(--accent);color:#fff}
.actions .ghost.danger{color:var(--bad)}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:14px}
.panels{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:12px;margin-top:14px}
aside{display:grid;gap:12px;align-content:start}
.panel{padding:20px;border-radius:var(--radius-md);background:var(--surface-1)}
.panel h2{margin:0 0 14px;font-size:13px}
.groups{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.groups li{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 17px;border-radius:var(--radius-row);background:var(--surface-2);cursor:pointer;transition:background 180ms var(--ease-enter)}
.groups li:hover{background:var(--surface-3)}
.groups>li>div:first-child{display:grid;gap:5px;min-width:0}
.groups strong{font-size:13px;word-break:break-all}
.groups small{color:var(--ink-muted);font-size:10px}
.count{display:grid;gap:4px;text-align:right}
.count b{font-size:22px;font-variant-numeric:tabular-nums}
.series{display:flex;align-items:flex-end;gap:3px;height:96px}
.series span{flex:1;min-height:3px;border-radius:4px 4px 2px 2px;background:var(--accent)}
.series span[data-empty="true"]{background:var(--surface-3)}
.note{margin:12px 0 0;color:var(--ink-muted);font-size:10px}
.devices{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.devices button{width:100%;display:grid;gap:4px;padding:12px 14px;border:0;border-radius:var(--radius-row);background:var(--surface-2);color:var(--ink);text-align:left;cursor:pointer}
.devices span{font-size:12px}
.devices small{color:var(--ink-muted);font-size:10px}
.meta{display:grid;gap:8px;margin:0}
.meta>div{display:grid;grid-template-columns:96px 1fr;gap:12px}
.meta dt{color:var(--ink-muted);font-size:10px}
.meta dd{margin:0;font-size:12px;word-break:break-all}
.reports{display:grid;gap:10px;margin-top:14px}
.reports article{padding:15px 17px;border-radius:var(--radius-row);background:var(--surface-2)}
.reports header{display:grid;gap:5px}
.reports header span{color:var(--ink-muted);font-size:10px}
.reports p{margin:10px 0 0;font-size:12px}
.reports pre{margin:10px 0 0;padding:12px 14px;max-height:220px;overflow:auto;border-radius:12px;background:var(--surface-1);font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
@media (max-width:1080px){.panels{grid-template-columns:1fr}}
</style>