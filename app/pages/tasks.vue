<script setup lang="ts">
type Task = {id:string;name:string;capabilityId:string;state:string;scheduledAt:string|null;expiresAt:string;createdAt:string;mode:string;batchSize:number|null;percent:number|null;failureThreshold:number;maxConcurrency:number;cancelRequested:number;lastError:string|null;batches:Record<string,number>;stats:{total:number;succeeded:number;failed:number;expired:number;cancelled:number;active:number}};
type Command = {id:string;deviceId:string;deviceName:string;orgNodeId:string|null;capabilityId:string;state:string;attemptCount:number;maxAttempts:number;offeredAt:string|null;acknowledgedAt:string|null;expiresAt:string;nextAttemptAt:string|null;lastError:string|null;result:unknown};
type TaskDetail = {task:{id:string;name:string;capabilityId:string;state:string;payload:unknown;mode:string;cancelRequested:number;lastError:string|null;pausedAt:string|null};stats:{total:number;succeeded:number;failed:number;expired:number;cancelled:number;cancelling:number;active:number};batches:{id:string;batchIndex:number;state:string;deviceCount:number}[];commands:{items:Command[];total:number;page:number;pageSize:number};timeline:{sequence:number;action:string;actorType:string;summary:string;createdAt:string}[]};
type ListResponse = {items:Task[];total:number;page:number;pageSize:number};
const { data, refresh } = await useFetch<ListResponse>("/api/v1/admin/tasks", { default: () => ({ items: [], total: 0, page: 1, pageSize: 50 }) });
// 目标统一来自全局目标选择：创建任务时把当前选择解析成设备快照。
const { deviceIds: targetDeviceIds, count: targetCount, summary: targetSummary, empty: targetEmpty } = useTargetSelection();
const tasks = computed(() => data.value?.items ?? []);
const showEditor = ref(false);
const showTargets = ref(false);

const toast = useToast();
const busy = ref(false);
const selectedId = ref("");
const detail = ref<TaskDetail | null>(null);
const detailBusy = ref(false);
const form = reactive({ name: "远程提醒", capabilityId: "notification.own-provider.send.v1", payload: "{}", ttlMinutes: 60, mode: "all" as "all"|"fixed"|"percent", batchSize: 50, percent: 10, failureThresholdPercent: 0, maxConcurrency: 0 });

/** 能力参数以可视化表单填写，Payload JSON 只作为高级入口保留。 */
type PayloadField = { key: string; label: string; kind: "text" | "textarea" | "select" | "color"; options?: [string, string][]; placeholder?: string; initial?: string; showWhen?: (values: Record<string, any>) => boolean };
type CapabilityDef = { id: string; label: string; risk?: boolean; fields: PayloadField[]; build: (values: Record<string, any>) => Record<string, unknown> };
const capabilityDefs: CapabilityDef[] = [
  {
    id: "notification.own-provider.send.v1", label: "远程提醒",
    fields: [{ key: "title", label: "通知标题", kind: "text", initial: "通知" }, { key: "content", label: "通知内容", kind: "textarea", initial: "" }],
    build: (values) => ({ title: values.title, content: values.content }),
  },
  {
    id: "theme.app.transient.v1", label: "颜色主题",
    fields: [{ key: "mode", label: "主题模式", kind: "select", options: [["0", "跟随系统"], ["1", "浅色"], ["2", "深色"]], initial: "0" }, { key: "primary", label: "主色（留空表示不修改）", kind: "color", initial: "" }],
    build: (values) => ({ mode: Number(values.mode), ...(values.primary ? { primary: values.primary } : {}) }),
  },
  { id: "weather.read-refresh.v1", label: "刷新天气", fields: [], build: () => ({}) },
  { id: "exact-time.read-sync.v1", label: "同步网络时间", fields: [], build: () => ({}) },
  {
    id: "time.offset.persist.v1", label: "时间偏移",
    fields: [
      { key: "mode", label: "方式", kind: "select", options: [["fixed", "固定偏移"], ["auto", "自动对齐集控端"], ["daily", "每日自动递增"]], initial: "fixed" },
      { key: "offsetSeconds", label: "偏移秒数", kind: "text", initial: "0", showWhen: (values) => values.mode === "fixed" },
      { key: "secondsPerDay", label: "每日递增秒数（负数递减）", kind: "text", initial: "5", showWhen: (values) => values.mode === "daily" },
      { key: "baseSeconds", label: "基线秒数（留空以设备当前偏移为基线）", kind: "text", initial: "", showWhen: (values) => values.mode === "daily" },
    ],
    build: (values) => {
      if (values.mode === "auto") return { auto: true };
      if (values.mode === "daily") {
        const base = values.baseSeconds === "" ? null : Number(values.baseSeconds) || 0;
        return { ...(base !== null ? { offsetSeconds: base } : {}), daily: { enabled: true, secondsPerDay: Number(values.secondsPerDay) || 0 } };
      }
      return { offsetSeconds: Number(values.offsetSeconds) || 0 };
    },
  },
  {
    id: "speech.queue.v1", label: "语音播报",
    fields: [{ key: "action", label: "动作", kind: "select", options: [["enqueue", "加入播报队列"], ["clear", "清空播报队列"]], initial: "enqueue" }, { key: "text", label: "播报文本", kind: "text", initial: "", showWhen: (values) => values.action === "enqueue" }],
    build: (values) => (values.action === "clear" ? { action: "clear" } : { action: "enqueue", text: values.text }),
  },
  {
    id: "app.window.basic.volatile.v1", label: "显示 / 隐藏主窗口",
    fields: [{ key: "action", label: "动作", kind: "select", options: [["show", "显示"], ["hide", "隐藏"]], initial: "show" }],
    build: (values) => ({ action: values.action }),
  },
  {
    id: "uri.navigate.v1", label: "打开 classisland: 链接",
    fields: [{ key: "uri", label: "classisland: URI", kind: "text", initial: "classisland://app/settings", placeholder: "classisland://app/settings" }],
    build: (values) => ({ uri: values.uri }),
  },
  {
    id: "tutorial.control.v1", label: "教程控制",
    fields: [{ key: "action", label: "动作", kind: "select", options: [["begin", "开始"], ["stop", "停止"], ["skip", "跳过"], ["reset", "重置完成状态"]], initial: "begin" }, { key: "path", label: "教程路径", kind: "text", initial: "", showWhen: (values) => values.action === "begin" }],
    build: (values) => (values.action === "begin" ? { action: "begin", path: values.path } : { action: values.action }),
  },
  {
    id: "app.lifecycle.v1", label: "重启 / 退出应用", risk: true,
    fields: [{ key: "action", label: "动作", kind: "select", options: [["restart", "重启"], ["stop", "退出"]], initial: "restart" }],
    build: (values) => ({ action: values.action }),
  },
];
const values = reactive<Record<string, any>>({});
const currentCapability = computed(() => capabilityDefs.find((def) => def.id === form.capabilityId) ?? capabilityDefs[0]!);
const visibleFields = computed(() => currentCapability.value.fields.filter((field) => !field.showWhen || field.showWhen(values)));
function resetPayloadValues() {
  for (const key of Object.keys(values)) delete values[key];
  for (const field of currentCapability.value.fields) values[field.key] = field.initial ?? "";
  syncPayload();
}
function syncPayload() { form.payload = JSON.stringify(currentCapability.value.build(values), null, 2); }
watch(() => form.capabilityId, resetPayloadValues);
watch(values, syncPayload, { deep: true });
resetPayloadValues();
const states = ["scheduled","running","paused","cancelling","completed","partial_failure","failed","expired","cancelled"];
const targetReady = computed(() => !targetEmpty.value);
function countState(state: string) { return tasks.value.filter((task) => task.state === state).length; }
function statOf(task: Task) { return `${task.stats.succeeded}/${task.stats.total} 成功 · ${task.stats.failed} 失败 · ${task.stats.active} 进行中`; }
function buildTargets() {
  return { deviceIds: targetDeviceIds.value };
}
async function createTask() {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(form.payload) as Record<string, unknown>; }
  catch { toast.err("命令内容格式有误，请检查后再试。"); return; }
  busy.value = true;
  try {
    await $fetch("/api/v1/admin/tasks", { method: "POST", headers: { origin: location.origin }, body: { ...form, ...buildTargets(), payload } });
    showEditor.value = false;
    toast.ok(`已创建任务「${form.name}」并下发到 ${targetCount.value} 台设备。`);
    await refresh();
  } catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "任务创建失败。"); }
  finally { busy.value = false; }
}
const actionLabels: Record<string, string> = { pause: "已暂停任务。", resume: "已继续任务。", cancel: "已请求取消任务。" };
async function taskAction(id: string, action: "pause"|"resume"|"cancel") {
  try {
    await $fetch(`/api/v1/admin/tasks/${id}/action`, { method: "POST", headers: { origin: location.origin }, body: { action } });
    toast.ok(actionLabels[action] ?? "操作已提交。");
    await refresh();
    if (selectedId.value === id) await openTask(id);
  } catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "任务操作失败。"); }
}
async function openTask(id: string) {
  detailBusy.value = true; selectedId.value = id; detail.value = null;
  try { detail.value = await $fetch<TaskDetail>(`/api/v1/admin/tasks/${id}`); }
  catch (cause) { toast.err((cause as { data?: { message?: string } })?.data?.message || "任务详情加载失败。"); }
  finally { detailBusy.value = false; }
}
function closeTask() { selectedId.value = ""; detail.value = null; }

/** 楼栋页「发布任务」深链进来时直接展开创建面板。 */
onMounted(() => { if (useRoute().query.new) showEditor.value = true; });
</script>

<template>
  <PageHeading kicker="把操作发给一批设备" title="任务">
    <button type="button" class="solid" @click="showEditor = true">创建任务</button>
  </PageHeading>

  <AppDialog v-if="showEditor" title="创建任务" kicker="立即下发" width="880px" @close="showEditor = false">
    <form id="task-editor" class="editor" @submit.prevent="createTask">
      <label>名称<input v-model="form.name" required></label>
      <label>能力<select v-model="form.capabilityId"><option v-for="def in capabilityDefs" :key="def.id" :value="def.id">{{ def.risk ? `${def.label}（高风险）` : def.label }}</option></select></label>
      <label>有效时间（分钟）<input v-model.number="form.ttlMinutes" min="1" max="10080" type="number"></label>
      <label>下发方式<select v-model="form.mode"><option value="all">一次全发</option><option value="fixed">固定批次</option><option value="percent">按比例分批</option></select></label>
      <label v-if="form.mode === 'fixed'">每批设备数<input v-model.number="form.batchSize" min="1" max="500" type="number"></label>
      <label v-if="form.mode === 'percent'">每批占比（%）<input v-model.number="form.percent" min="1" max="100" type="number"></label>
      <label>失败率上限（%）<input v-model.number="form.failureThresholdPercent" min="0" max="100" type="number"></label>
      <label>最大并发（0 不限）<input v-model.number="form.maxConcurrency" min="0" max="1000" type="number"></label>

      <fieldset class="wide target">
        <legend>目标</legend>
        <div class="target-head">
          <span><strong>{{ targetSummary }}</strong> · {{ targetCount }} 台设备</span>
          <button type="button" class="ghost" @click="showTargets = true">选择目标</button>
        </div>
      </fieldset>

      <fieldset class="wide payload">
        <legend>命令内容</legend>
        <p v-if="currentCapability.risk" class="risk">高风险：会重启或退出设备上的 ClassIsland。</p>
        <p v-else-if="!visibleFields.length" class="static">该能力没有参数，直接下发即可。</p>
        <template v-for="field in visibleFields" :key="field.key">
          <label v-if="field.kind === 'textarea'">{{ field.label }}<textarea v-model="values[field.key]" rows="3" /></label>
          <label v-else-if="field.kind === 'select'">{{ field.label }}<select v-model="values[field.key]"><option v-for="option in field.options" :key="option[0]" :value="option[0]">{{ option[1] }}</option></select></label>
          <label v-else-if="field.kind === 'color'">{{ field.label }}<span class="color-row"><input v-model="values[field.key]" type="color"><input v-model="values[field.key]" maxlength="7" placeholder="留空"></span></label>
          <label v-else>{{ field.label }}<input v-model="values[field.key]" :placeholder="field.placeholder"></label>
        </template>
        <details class="advanced">
          <summary>高级：直接编辑命令内容</summary>
          <textarea v-model="form.payload" rows="6" />
        </details>
      </fieldset>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showEditor = false">取消</button>
      <button type="submit" form="task-editor" :disabled="busy || !targetReady">{{ busy ? '下发中…' : '创建并下发' }}</button>
    </template>
  </AppDialog>

  <section class="state-strip">
    <div v-for="state in states" :key="state"><span>{{ labelOf(TASK_STATE_LABELS, state) }}</span><strong>{{ countState(state) }}</strong></div>
  </section>

  <section v-if="tasks.length" class="list tasks">
    <article v-for="task in tasks" :key="task.id" :class="{ selected: task.id === selectedId }">
      <div class="row-main">
        <strong>{{ task.name }}</strong>
        <small>{{ labelOf(CAPABILITY_LABELS, task.capabilityId) }} · {{ labelOf(TASK_STATE_LABELS, task.state) }} · {{ labelOf(MODE_LABELS, task.mode) }}</small>
        <small>{{ statOf(task) }}</small>
      </div>
      <div class="row-actions">
        <button v-if="task.state === 'running' || task.state === 'scheduled'" type="button" @click="taskAction(task.id,'pause')">暂停</button>
        <button v-if="task.state === 'paused'" type="button" @click="taskAction(task.id,'resume')">继续</button>
        <button type="button" @click="taskAction(task.id,'cancel')">取消</button>
        <button type="button" @click="openTask(task.id)">详情</button>
      </div>
    </article>
  </section>
  <EmptyState v-else title="还没有任务" />
  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />

  <AppDialog v-if="selectedId" title="任务详情" kicker="执行详情" width="940px" @close="closeTask">
    <p v-if="detailBusy">加载中…</p>
    <template v-else-if="detail">
      <p v-if="detail.task.lastError" class="warn">{{ detail.task.lastError }}</p>
      <dl class="meta">
        <div><dt>状态</dt><dd>{{ labelOf(TASK_STATE_LABELS, detail.task.state) }}</dd></div>
        <div><dt>目标设备</dt><dd>{{ detail.stats.total }}</dd></div>
        <div><dt>成功</dt><dd>{{ detail.stats.succeeded }}</dd></div>
        <div><dt>失败</dt><dd>{{ detail.stats.failed }}</dd></div>
        <div><dt>过期</dt><dd>{{ detail.stats.expired }}</dd></div>
        <div><dt>取消</dt><dd>{{ detail.stats.cancelled }}</dd></div>
        <div><dt>撤回中</dt><dd>{{ detail.stats.cancelling }}</dd></div>
        <div><dt>进行中</dt><dd>{{ detail.stats.active }}</dd></div>
      </dl>
      <h3>批次</h3>
      <div class="chips">
        <span v-for="batch in detail.batches" :key="batch.id">第 {{ batch.batchIndex + 1 }} 批 · {{ labelOf(BATCH_STATE_LABELS, batch.state) }} · {{ batch.deviceCount }} 台</span>
        <span v-if="!detail.batches.length">无批次记录</span>
      </div>
      <h3>目标执行（{{ detail.commands.total }}）</h3>
      <table>
        <thead><tr><th>设备</th><th>状态</th><th>尝试</th><th>确认时间</th><th>结果 / 错误</th></tr></thead>
        <tbody>
          <tr v-for="command in detail.commands.items" :key="command.id">
            <td>{{ command.deviceName }}</td>
            <td>{{ labelOf(COMMAND_STATE_LABELS, command.state) }}</td>
            <td>{{ command.attemptCount }}/{{ command.maxAttempts }}</td>
            <td class="time">{{ command.acknowledgedAt || '—' }}</td>
            <td class="result">{{ command.lastError || (command.result ? JSON.stringify(command.result) : '—') }}</td>
          </tr>
        </tbody>
      </table>
      <h3>审计时间线</h3>
      <ul class="timeline">
        <li v-for="entry in detail.timeline" :key="entry.sequence"><small>{{ entry.createdAt }}</small><span>{{ entry.summary }}</span></li>
        <li v-if="!detail.timeline.length">暂无事件</li>
      </ul>
    </template>
  </AppDialog>
</template><style scoped>
.editor { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.editor > label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.editor input, .editor select, .editor textarea { width: 100%; }
.editor textarea { padding: 12px 14px; line-height: 1.7; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
.wide { grid-column: 1 / -1; }
fieldset { margin: 0; padding: 22px 24px; border: 1px solid var(--line-soft); }
legend { padding: 0 10px; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.target-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.target-head span { color: var(--ink-soft); font-size: 12px; }
.target-head strong { color: var(--ink); font-weight: 600; }
.risk { margin: 0 0 16px; color: var(--bad); font-size: 12px; }
.static { margin: 0; color: var(--ink-faint); font-size: 11px; }
.color-row { display: flex; gap: 10px; }
.advanced { margin-top: 16px; }
.advanced summary { cursor: pointer; color: var(--ink-soft); font-size: 12px; }
.advanced textarea { margin-top: 12px; }

/* 状态计数：RhineLab 微标签 + 大号数字。 */
.state-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0; border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); }
.state-strip div { display: grid; gap: 8px; padding: 18px 20px; border-right: 1px solid var(--line-soft); }
.state-strip div:last-child { border-right: 0; }
.state-strip span { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.state-strip strong { font-size: 30px; font-weight: 600; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
.tasks { margin-top: 22px; }
.tasks article { gap: 20px; }
.tasks article.selected { background: var(--accent-wash); }
.tasks .row-main { gap: 6px; }
.tasks .row-main strong { font-size: 15px; }
.warn { margin: 0 0 18px; color: var(--bad); font-size: 12px; }
/* 详情：RhineLab .metadata 的说明 / 取值对照。 */
.meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px 28px; margin: 0 0 8px; }
.meta dt { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; }
.meta dd { margin: 8px 0 0; font-size: 20px; font-weight: 600; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; }
h3 { margin: 28px 0 14px; color: var(--ink-muted); font-size: 10px; font-weight: 400; letter-spacing: 1.2px; }
.chips { margin-bottom: 4px; }
.time { color: var(--ink-muted); font-size: 11px; }
.result { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
.timeline { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.timeline li { display: grid; gap: 6px; padding: 14px 2px; border-bottom: 1px solid var(--line-soft); }
.timeline small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.6px; }
.timeline span { font-size: 13px; }
@media (max-width: 900px) {
  .editor { grid-template-columns: 1fr; }
  .meta { grid-template-columns: repeat(2, 1fr); }
}
</style>