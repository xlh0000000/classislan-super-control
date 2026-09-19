<script setup lang="ts">
type Schedule = {
  id: string; name: string; capabilityId: string; payload: Record<string, unknown>;
  targets: unknown[]; deviceIds: string[];
  repeat: "daily" | "weekly" | "monthly" | "interval";
  timeOfDay: string | null; weekdays: number[] | null; dayOfMonth: number | null; intervalMinutes: number | null;
  tzOffsetMinutes: number; startAt: string; endAt: string | null; ttlMinutes: number;
  mode: string; batchSize: number | null; percent: number | null;
  failureThreshold: number; maxConcurrency: number; maxAttempts: number;
  state: "active" | "paused" | "finished"; nextRunAt: string | null; lastRunAt: string | null;
  lastTaskId: string | null; lastError: string | null; createdByName: string | null;
};
type Trigger = {
  id: string; name: string; kind: "device_offline" | "crash_threshold";
  offlineMinutes?: number; crashCount?: number; windowMinutes?: number;
  scopeType: "school" | "organization"; scopeId: string | null;
  targets: unknown[]; capabilityId: string; payload: Record<string, unknown>;
  ttlMinutes: number; cooldownMinutes: number; state: "active" | "paused";
  lastFiredAt: string | null; lastTaskId: string | null; lastError: string | null; createdByName: string | null;
};
type ListResponse<T> = { items: T[]; total: number; page: number; pageSize: number };

const { data: scheduleData, refresh: refreshSchedules } = await useFetch<ListResponse<Schedule>>("/api/v1/admin/schedules", { default: () => ({ items: [], total: 0, page: 1, pageSize: 200 }) });
const { data: triggerData, refresh: refreshTriggers } = await useFetch<ListResponse<Trigger>>("/api/v1/admin/triggers", { default: () => ({ items: [], total: 0, page: 1, pageSize: 200 }) });
const schedules = computed(() => scheduleData.value?.items ?? []);
const triggers = computed(() => triggerData.value?.items ?? []);
const { org, selection, deviceIds: targetDeviceIds, summary: targetSummary, count: targetCount } = useTargetSelection();
const toast = useToast();
const busy = ref(false);
const tab = ref("schedules");
const showScheduleEditor = ref(false);
const showTriggerEditor = ref(false);
const showTargets = ref(false);

const CAPABILITIES: [string, string][] = [
  ["notification.own-provider.send.v1", "远程提醒"],
  ["speech.queue.v1", "语音播报"],
  ["theme.app.transient.v1", "颜色主题"],
  ["weather.read-refresh.v1", "刷新天气"],
  ["app.window.basic.volatile.v1", "显示/隐藏主窗口"],
  ["uri.navigate.v1", "打开 classisland: 链接"],
  ["app.lifecycle.v1", "重启/退出应用（高风险）"],
  ["time.offset.persist.v1", "时间偏移"],
];
const weekdayLabels = [["1", "一"], ["2", "二"], ["3", "三"], ["4", "四"], ["5", "五"], ["6", "六"], ["7", "日"]];

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}
function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

const emptySchedule = () => ({
  id: "", name: "", capabilityId: CAPABILITIES[0]![0], payload: '{\n  "title": "例行任务",\n  "content": "{{deviceName}}"\n}',
  repeat: "daily" as Schedule["repeat"], timeOfDay: "07:30", weekdays: [1, 2, 3, 4, 5] as number[],
  dayOfMonth: 1, intervalMinutes: 60, startAt: toLocalInput(new Date().toISOString()), endAt: "",
  ttlMinutes: 60, mode: "all" as "all" | "fixed" | "percent", batchSize: 50, percent: 10,
});
const scheduleForm = reactive(emptySchedule());
const emptyTrigger = () => ({
  id: "", name: "", kind: "device_offline" as Trigger["kind"],
  offlineMinutes: 30, crashCount: 3, windowMinutes: 60,
  scopeType: "school" as Trigger["scopeType"], scopeId: "",
  selfTarget: true, capabilityId: CAPABILITIES[0]![0],
  payload: '{\n  "title": "设备告警",\n  "content": "{{deviceName}} 已离线超过 {{offlineMinutes}} 分钟"\n}',
  ttlMinutes: 60, cooldownMinutes: 60,
});
const triggerForm = reactive(emptyTrigger());

function openScheduleEditor(row?: Schedule) {
  Object.assign(scheduleForm, emptySchedule());
  if (row) {
    Object.assign(scheduleForm, {
      id: row.id, name: row.name, capabilityId: row.capabilityId,
      payload: JSON.stringify(row.payload, null, 2),
      repeat: row.repeat, timeOfDay: row.timeOfDay ?? "07:30", weekdays: row.weekdays ?? [1, 2, 3, 4, 5],
      dayOfMonth: row.dayOfMonth ?? 1, intervalMinutes: row.intervalMinutes ?? 60,
      startAt: toLocalInput(row.startAt), endAt: toLocalInput(row.endAt),
      ttlMinutes: row.ttlMinutes, mode: row.mode as "all" | "fixed" | "percent",
      batchSize: row.batchSize ?? 50, percent: row.percent ?? 10,
    });
    // 编辑时把已存目标装进全局选择，避免保存时静默换成别人选的列表。
    if (row.deviceIds.length) applyDeviceTargets(row.deviceIds);
  }
  showScheduleEditor.value = true;
}
function openTriggerEditor(row?: Trigger) {
  Object.assign(triggerForm, emptyTrigger());
  if (row) {
    Object.assign(triggerForm, {
      id: row.id, name: row.name, kind: row.kind,
      offlineMinutes: row.offlineMinutes ?? 30, crashCount: row.crashCount ?? 3, windowMinutes: row.windowMinutes ?? 60,
      scopeType: row.scopeType, scopeId: row.scopeId ?? "",
      selfTarget: row.targets.length === 0,
      capabilityId: row.capabilityId, payload: JSON.stringify(row.payload, null, 2),
      ttlMinutes: row.ttlMinutes, cooldownMinutes: row.cooldownMinutes,
    });
  }
  showTriggerEditor.value = true;
}
function toggleWeekday(day: number) {
  const list = scheduleForm.weekdays.includes(day);
  scheduleForm.weekdays = list ? scheduleForm.weekdays.filter((d) => d !== day) : [...scheduleForm.weekdays, day].sort();
}
/** 把已存调度目标装进全局目标选择（组织/标签选择器暂不支持，保存时以显式设备列表落回）。 */
function applyDeviceTargets(ids: string[]) {
  selection.value = { school: false, orgNodeIds: [], tagIds: [], deviceIds: [...ids] };
}

async function submitSchedule() {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(scheduleForm.payload) as Record<string, unknown>; }
  catch { toast.err("命令内容格式有误，请检查后再试。"); return; }
  const deviceIds = targetDeviceIds.value;
  if (!deviceIds.length) { toast.err("请先选择目标设备。"); return; }
  const body = {
    name: scheduleForm.name.trim() || `${CAPABILITIES.find((c) => c[0] === scheduleForm.capabilityId)?.[1] ?? "任务"} · 周期`,
    capabilityId: scheduleForm.capabilityId, payload, deviceIds, targets: [],
    repeat: scheduleForm.repeat,
    timeOfDay: scheduleForm.repeat === "interval" ? undefined : scheduleForm.timeOfDay,
    weekdays: scheduleForm.repeat === "weekly" ? scheduleForm.weekdays : undefined,
    dayOfMonth: scheduleForm.repeat === "monthly" ? scheduleForm.dayOfMonth : undefined,
    intervalMinutes: scheduleForm.repeat === "interval" ? scheduleForm.intervalMinutes : undefined,
    startAt: fromLocalInput(scheduleForm.startAt) ?? new Date().toISOString(),
    endAt: fromLocalInput(scheduleForm.endAt),
    ttlMinutes: scheduleForm.ttlMinutes, mode: scheduleForm.mode,
    batchSize: scheduleForm.mode === "fixed" ? scheduleForm.batchSize : undefined,
    percent: scheduleForm.mode === "percent" ? scheduleForm.percent : undefined,
  };
  busy.value = true;
  try {
    if (scheduleForm.id)
      await $fetch(`/api/v1/admin/schedules/${scheduleForm.id}`, { method: "PATCH", headers: { origin: location.origin }, body });
    else
      await $fetch("/api/v1/admin/schedules", { method: "POST", headers: { origin: location.origin }, body });
    showScheduleEditor.value = false;
    toast.ok(scheduleForm.id ? "调度已更新。" : "调度已创建。");
    await refreshSchedules();
  } catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "保存调度失败。"); }
  finally { busy.value = false; }
}

async function submitTrigger() {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(triggerForm.payload) as Record<string, unknown>; }
  catch { toast.err("命令内容格式有误，请检查后再试。"); return; }
  if (!triggerForm.selfTarget && !targetDeviceIds.value.length) { toast.err("告警目标模式需要先选择目标设备。"); return; }
  const body = {
    name: triggerForm.name.trim() || "事件触发任务", kind: triggerForm.kind,
    offlineMinutes: triggerForm.kind === "device_offline" ? triggerForm.offlineMinutes : undefined,
    crashCount: triggerForm.kind === "crash_threshold" ? triggerForm.crashCount : undefined,
    windowMinutes: triggerForm.kind === "crash_threshold" ? triggerForm.windowMinutes : undefined,
    scopeType: triggerForm.scopeType, scopeId: triggerForm.scopeType === "organization" ? (triggerForm.scopeId || null) : null,
    // 自身目标模式留空 targets（由引擎填出事设备）；否则把当前全局选择作为告警受众。
    targets: triggerForm.selfTarget ? [] : targetDeviceIds.value.map((id) => ({ type: "device", id })),
    capabilityId: triggerForm.capabilityId, payload,
    ttlMinutes: triggerForm.ttlMinutes, cooldownMinutes: triggerForm.cooldownMinutes,
  };
  busy.value = true;
  try {
    if (triggerForm.id)
      await $fetch(`/api/v1/admin/triggers/${triggerForm.id}`, { method: "PATCH", headers: { origin: location.origin }, body });
    else
      await $fetch("/api/v1/admin/triggers", { method: "POST", headers: { origin: location.origin }, body });
    showTriggerEditor.value = false;
    toast.ok(triggerForm.id ? "触发器已更新。" : "触发器已创建。");
    await refreshTriggers();
  } catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "保存触发器失败。"); }
  finally { busy.value = false; }
}

async function postAction(url: string, body: Record<string, unknown>, refresh: () => Promise<unknown>) {
  try {
    await $fetch(url, { method: "POST", headers: { origin: location.origin }, body });
    toast.ok("操作已提交。");
    await refresh();
  } catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "操作失败。"); }
}
const scheduleAction = (id: string, action: string) => postAction(`/api/v1/admin/schedules/${id}/action`, { action }, refreshSchedules);
const triggerAction = (id: string, action: string) => postAction(`/api/v1/admin/triggers/${id}/action`, { action }, refreshTriggers);
async function removeResource(url: string, refresh: () => Promise<unknown>) {
  try {
    await $fetch(url, { method: "DELETE", headers: { origin: location.origin } });
    toast.ok("已删除。");
    await refresh();
  } catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "删除失败。"); }
}
const deleteSchedule = (id: string) => removeResource(`/api/v1/admin/schedules/${id}`, refreshSchedules);
const deleteTrigger = (id: string) => removeResource(`/api/v1/admin/triggers/${id}`, refreshTriggers);
</script>

<template>
  <PageHeading kicker="让集控台自己动起来" title="自动任务">
    <button type="button" class="solid" @click="tab === 'schedules' ? openScheduleEditor() : openTriggerEditor()">
      {{ tab === "schedules" ? "新建调度" : "新建触发器" }}
    </button>
  </PageHeading>
  <PageTabs v-model="tab" :items="[{ key: 'schedules', label: '周期调度' }, { key: 'triggers', label: '事件触发' }]" />

  <!-- 周期调度列表 -->
  <section v-if="tab === 'schedules'">
    <section v-if="schedules.length" class="list">
      <article v-for="row in schedules" :key="row.id" class="row">
        <div class="row-main">
          <strong>{{ row.name }}</strong>
          <small>{{ labelOf(CAPABILITY_LABELS, row.capabilityId) }} · {{ labelOf(REPEAT_LABELS, row.repeat) }}{{ row.repeat !== 'interval' ? ` ${row.timeOfDay}` : ` 每 ${row.intervalMinutes} 分钟` }}<template v-if="row.repeat === 'weekly'">（{{ row.weekdays?.map((d) => `周${['一','二','三','四','五','六','日'][d - 1]}`).join('、') }}）</template><template v-if="row.repeat === 'monthly'">（每月 {{ row.dayOfMonth }} 号）</template></small>
          <small>下次 {{ fmt(row.nextRunAt) }} · 上次 {{ fmt(row.lastRunAt) }}</small>
          <small v-if="row.lastError" class="warn">上次未能生成任务：{{ row.lastError }}</small>
        </div>
        <div class="row-side">
          <span class="tag">{{ labelOf(AUTO_TASK_STATE_LABELS, row.state) }}</span>
          <div class="row-actions">
            <button v-if="row.state === 'active'" type="button" @click="scheduleAction(row.id, 'pause')">暂停</button>
            <button v-if="row.state === 'paused'" type="button" @click="scheduleAction(row.id, 'resume')">恢复</button>
            <button v-if="row.state === 'active'" type="button" @click="scheduleAction(row.id, 'run')">立即执行</button>
            <button v-if="row.state !== 'finished'" type="button" @click="openScheduleEditor(row)">编辑</button>
            <button type="button" @click="deleteSchedule(row.id)">删除</button>
          </div>
        </div>
      </article>
    </section>
    <EmptyState v-else title="还没有周期调度" />
  </section>

  <!-- 事件触发列表 -->
  <section v-else>
    <section v-if="triggers.length" class="list">
      <article v-for="row in triggers" :key="row.id" class="row">
        <div class="row-main">
          <strong>{{ row.name }}</strong>
          <small>{{ row.kind === 'device_offline' ? `离线超过 ${row.offlineMinutes} 分钟` : `${row.windowMinutes} 分钟内崩溃满 ${row.crashCount} 次` }} · {{ row.scopeType === 'school' ? '全校' : `组织 · ${org.nodes.find((n) => n.id === row.scopeId)?.name ?? '未知'}` }}</small>
          <small>{{ labelOf(CAPABILITY_LABELS, row.capabilityId) }} · 冷却 {{ row.cooldownMinutes }} 分钟 · 上次触发 {{ fmt(row.lastFiredAt) }}</small>
          <small v-if="row.lastError" class="warn">上次未能生成任务：{{ row.lastError }}</small>
        </div>
        <div class="row-side">
          <span class="tag">{{ labelOf(AUTO_TASK_STATE_LABELS, row.state) }}</span>
          <div class="row-actions">
            <button v-if="row.state === 'active'" type="button" @click="triggerAction(row.id, 'pause')">暂停</button>
            <button v-if="row.state === 'paused'" type="button" @click="triggerAction(row.id, 'resume')">恢复</button>
            <button type="button" @click="openTriggerEditor(row)">编辑</button>
            <button type="button" @click="deleteTrigger(row.id)">删除</button>
          </div>
        </div>
      </article>
    </section>
    <EmptyState v-else title="还没有事件触发器" />
  </section>

  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />

  <!-- 调度编辑器 -->
  <AppDialog v-if="showScheduleEditor" :title="scheduleForm.id ? '编辑调度' : '新建调度'" kicker="周期任务" width="860px" @close="showScheduleEditor = false">
    <form id="schedule-editor" class="editor" @submit.prevent="submitSchedule">
      <label>名称<input v-model="scheduleForm.name" maxlength="60" placeholder="留空自动命名"></label>
      <label>能力<select v-model="scheduleForm.capabilityId"><option v-for="cap in CAPABILITIES" :key="cap[0]" :value="cap[0]">{{ cap[1] }}</option></select></label>
      <label>重复<select v-model="scheduleForm.repeat"><option value="daily">每天</option><option value="weekly">按星期</option><option value="monthly">每月几号</option><option value="interval">固定间隔</option></select></label>
      <label v-if="scheduleForm.repeat !== 'interval'">触发时刻<input v-model="scheduleForm.timeOfDay" type="time"></label>
      <div v-if="scheduleForm.repeat === 'weekly'" class="wide weekdays">
        <button v-for="day in weekdayLabels" :key="day[0]" type="button" :class="{ on: scheduleForm.weekdays.includes(Number(day[0])) }" @click="toggleWeekday(Number(day[0]))">周{{ day[1] }}</button>
      </div>
      <label v-if="scheduleForm.repeat === 'monthly'">几号<input v-model.number="scheduleForm.dayOfMonth" type="number" min="1" max="31"></label>
      <label v-if="scheduleForm.repeat === 'interval'">间隔分钟<input v-model.number="scheduleForm.intervalMinutes" type="number" min="5" max="20160"></label>
      <label>开始时间<input v-model="scheduleForm.startAt" type="datetime-local"></label>
      <label>结束时间（可选）<input v-model="scheduleForm.endAt" type="datetime-local"></label>
      <label>有效时间（分钟）<input v-model.number="scheduleForm.ttlMinutes" type="number" min="1" max="10080"></label>
      <label>下发方式<select v-model="scheduleForm.mode"><option value="all">一次全发</option><option value="fixed">固定批次</option><option value="percent">按比例分批</option></select></label>
      <label v-if="scheduleForm.mode === 'fixed'">每批设备数<input v-model.number="scheduleForm.batchSize" type="number" min="1" max="500"></label>
      <label v-if="scheduleForm.mode === 'percent'">每批占比（%）<input v-model.number="scheduleForm.percent" type="number" min="1" max="100"></label>

      <fieldset class="wide target">
        <legend>目标</legend>
        <div class="target-head">
          <span><strong>{{ targetSummary }}</strong> · {{ targetCount }} 台设备</span>
          <button type="button" class="ghost" @click="showTargets = true">选择目标</button>
        </div>
      </fieldset>
      <label class="wide">命令内容<textarea v-model="scheduleForm.payload" rows="6"></textarea></label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showScheduleEditor = false">取消</button>
      <button type="submit" form="schedule-editor" :disabled="busy">{{ busy ? "保存中…" : "保存" }}</button>
    </template>
  </AppDialog>

  <!-- 触发器编辑器 -->
  <AppDialog v-if="showTriggerEditor" :title="triggerForm.id ? '编辑触发器' : '新建触发器'" kicker="事件任务" width="860px" @close="showTriggerEditor = false">
    <form id="trigger-editor" class="editor" @submit.prevent="submitTrigger">
      <label>名称<input v-model="triggerForm.name" maxlength="60" placeholder="留空自动命名"></label>
      <label>事件<select v-model="triggerForm.kind"><option value="device_offline">设备离线超时</option><option value="crash_threshold">崩溃次数阈值</option></select></label>
      <label v-if="triggerForm.kind === 'device_offline'">离线分钟<input v-model.number="triggerForm.offlineMinutes" type="number" min="1" max="10080"></label>
      <template v-else>
        <label>窗口分钟<input v-model.number="triggerForm.windowMinutes" type="number" min="1" max="10080"></label>
        <label>崩溃次数<input v-model.number="triggerForm.crashCount" type="number" min="1" max="1000"></label>
      </template>
      <label>监控范围<select v-model="triggerForm.scopeType"><option value="school">全校</option><option value="organization">指定组织</option></select></label>
      <label v-if="triggerForm.scopeType === 'organization'">组织节点<select v-model="triggerForm.scopeId"><option value="" disabled>选择组织…</option><option v-for="node in org.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
      <label>冷却分钟<input v-model.number="triggerForm.cooldownMinutes" type="number" min="1" max="10080"></label>
      <label>有效时间（分钟）<input v-model.number="triggerForm.ttlMinutes" type="number" min="1" max="10080"></label>
      <label>能力<select v-model="triggerForm.capabilityId"><option v-for="cap in CAPABILITIES" :key="cap[0]" :value="cap[0]">{{ cap[1] }}</option></select></label>

      <label class="wide toggle"><input v-model="triggerForm.selfTarget" type="checkbox"><span>动作发给{{ triggerForm.kind === 'device_offline' ? '离线设备本身' : '出事设备本身' }}（取消勾选则发给当前目标：{{ targetSummary }} · {{ targetCount }} 台<template v-if="!triggerForm.selfTarget"> <button type="button" class="ghost" @click.prevent="showTargets = true">选择目标</button></template>）</span></label>
      <label class="wide">命令内容（可用占位符 {{ '\u007b\u007bdeviceName\u007d\u007d' }}、{{ '\u007b\u007bdeviceId\u007d\u007d' }}<template v-if="triggerForm.kind === 'device_offline'">、{{ '\u007b\u007bofflineMinutes\u007d\u007d' }}</template><template v-else>、{{ '\u007b\u007bcrashCount\u007d\u007d' }}、{{ '\u007b\u007bwindowMinutes\u007d\u007d' }}</template>）
        <textarea v-model="triggerForm.payload" rows="6"></textarea>
      </label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showTriggerEditor = false">取消</button>
      <button type="submit" form="trigger-editor" :disabled="busy">{{ busy ? "保存中…" : "保存" }}</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.list { display: grid; gap: 12px; }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 18px 20px; border: 1px solid var(--line-soft); }
.row-main { display: grid; gap: 5px; min-width: 0; }
.row-main strong { font-size: 15px; }
.row-main small { color: var(--ink-muted); font-size: 11px; }
.row-side { display: grid; gap: 10px; justify-items: end; flex: none; }
.tag { padding: 5px 10px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.warn { color: var(--bad); }
.editor { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.editor > label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.editor input, .editor select, .editor textarea { width: 100%; }
.editor textarea { padding: 12px 14px; line-height: 1.7; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
.wide { grid-column: 1 / -1; }
fieldset { margin: 0; padding: 22px 24px; border: 1px solid var(--line-soft); }
legend { padding: 0 10px; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.target-head span { color: var(--ink-soft); font-size: 12px; }
.target-head strong { color: var(--ink); font-weight: 600; }
.target-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.weekdays { display: flex; flex-wrap: wrap; gap: 8px; }
.weekdays button { min-height: var(--control-h-sm); padding: 0 14px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 12px; }
.weekdays button.on { background: var(--fill); color: var(--fill-ink); border-color: var(--fill); }
.toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.toggle span { font-size: 12px; color: var(--ink-soft); }
@media (max-width: 900px) { .editor { grid-template-columns: 1fr; } .row { flex-direction: column; } }
</style>
