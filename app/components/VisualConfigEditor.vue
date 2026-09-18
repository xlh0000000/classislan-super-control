<script setup lang="ts">
import {
  CONFIG_KIND_LABELS,
  ISLAND_SEPARATION_MODES,
  TEMP_GROUP_TYPES,
  fromColorInput,
  newComponentLine,
  newComponentNode,
  readComponentLines,
  readProfileSettings,
  settingFields,
  boolSetting,
  numberSetting,
  textSetting,
  toColorInput,
  writeComponentLines,
  writeProfileSettings,
  type ComponentLineModel,
  type ComponentNodeModel,
  type ProfileSettingsModel,
  type ScalarValue,
} from "#shared/classisland-config";

const props = defineProps<{ configurationId: string; kind: string; name: string; revision?: number }>();
const emit = defineEmits<{ saved: [number]; close: [] }>();
const toast = useToast();

const busy = ref(false);
const loading = ref(true);
const revision = ref(props.revision ?? 0);
const tab = ref("visual");
const jsonText = ref("");
const source = ref<Record<string, unknown>>({});
const profile = ref<ProfileSettingsModel | null>(null);
const lines = ref<ComponentLineModel[]>([]);

const kindTitle = computed(() => CONFIG_KIND_LABELS[props.kind] ?? props.kind);
/** 目前只有档案与组件布局有可靠的结构定义，其余类型只能编辑 JSON。 */
const hasVisual = computed(() => props.kind === "profile" || props.kind === "components");
const showVisual = computed(() => hasVisual.value && tab.value === "visual");
const tabs = computed(() => (hasVisual.value ? [{ key: "visual", label: "可视化" }, { key: "json", label: "源码" }] : []));

function buildModels() {
  profile.value = props.kind === "profile" ? readProfileSettings(source.value) : null;
  lines.value = props.kind === "components" ? readComponentLines(source.value) : [];
}

function currentDocument(): Record<string, unknown> {
  if (props.kind === "profile" && profile.value) return writeProfileSettings(profile.value);
  if (props.kind === "components") return writeComponentLines(source.value, lines.value);
  return source.value;
}

function setTab(next: string) {
  if (next === tab.value) return;
  if (next === "json") jsonText.value = JSON.stringify(currentDocument(), null, 2);
  else if (!applyJson()) return;
  tab.value = next;
}

function applyJson(): boolean {
  try {
    const parsed: unknown = JSON.parse(jsonText.value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      toast.err("内容格式有误：整体应为一个对象。");
      return false;
    }
    source.value = parsed as Record<string, unknown>;
    buildModels();
    return true;
  } catch {
    toast.err("内容格式有误，请检查后再切换。");
    return false;
  }
}

function move<T>(list: T[], index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  if (item !== undefined) list.splice(target, 0, item);
}

function setColor(node: { backgroundColor: string }, value: string) {
  node.backgroundColor = fromColorInput(value, node.backgroundColor);
}

function setSetting(node: ComponentNodeModel, key: string, value: ScalarValue) {
  node.settings[key] = value;
}

function numberFrom(event: Event): number {
  const value = Number((event.target as HTMLInputElement).value);
  return Number.isFinite(value) ? value : 0;
}

async function save() {
  if (tab.value === "json" && !applyJson()) return;
  busy.value = true;
  try {
    const result = await $fetch<{ revision: number }>("/api/v1/admin/configurations", {
      method: "POST",
      headers: { origin: location.origin },
      body: { configurationId: props.configurationId, kind: props.kind, name: props.name, document: currentDocument() },
    });
    revision.value = result.revision;
    source.value = currentDocument();
    buildModels();
    if (tab.value === "json") jsonText.value = JSON.stringify(source.value, null, 2);
    toast.ok(`已存成第 ${result.revision} 版。`);
    emit("saved", result.revision);
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存失败，检查一下结构。");
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    const history = await $fetch<{ documentJson: string }[]>(`/api/v1/admin/configurations/${props.configurationId}/history`);
    const latest = history[0];
    source.value = latest ? (JSON.parse(latest.documentJson) as Record<string, unknown>) : {};
    buildModels();
    tab.value = hasVisual.value ? "visual" : "json";
    if (!hasVisual.value) jsonText.value = JSON.stringify(source.value, null, 2);
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "读不到配置内容。");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <AppDialog
    :title="props.name"
    :kicker="`${kindTitle} · 当前第 ${revision} 版`"
    width="1080px"
    @close="emit('close')"
  >
    <div v-if="loading" class="muted">加载中…</div>
    <template v-else>
      <PageTabs v-if="hasVisual" :model-value="tab" :items="tabs" @update:model-value="setTab" />
      <p v-else class="notice">这个类型没有可视化表单，只能直接编辑内容本身。</p>

      <template v-if="showVisual && profile">
        <section class="group">
          <h3>档案</h3>
          <div class="row"><span class="label">档案名称</span><input v-model="profile.name" maxlength="80"></div>
        </section>
        <section class="group">
          <h3>叠加课表</h3>
          <div class="row">
            <SwitchToggle v-model="profile.overlayEnabled" label="启用叠加层" hint="在正常课表上再叠一层" />
          </div>
          <div v-if="profile.overlayEnabled" class="row">
            <span class="label">叠哪张课表</span>
            <select v-model="profile.overlayClassPlanId">
              <option value="">未选</option>
              <option v-for="plan in profile.classPlans" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
            </select>
          </div>
        </section>
        <section class="group">
          <h3>临时课表群</h3>
          <div class="row">
            <SwitchToggle v-model="profile.tempGroupEnabled" label="启用临时课表群" hint="换一整套课表" />
          </div>
          <div v-if="profile.tempGroupEnabled" class="row">
            <span class="label">生效方式</span>
            <select v-model.number="profile.tempGroupType">
              <option v-for="type in TEMP_GROUP_TYPES" :key="type.value" :value="type.value">{{ type.label }}</option>
            </select>
          </div>
        </section>
        <section class="group">
          <h3>默认课表群</h3>
          <div class="row">
            <span class="label">开机时用哪个课表群</span>
            <select v-model="profile.selectedClassPlanGroupId">
              <option v-for="group in profile.groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </div>
        </section>
        <section class="group">
          <h3>课表内容</h3>
          <div class="row">
            <span class="label">科目、时间表和一周课表在课表页改</span>
            <NuxtLink class="link" :to="`/timetable?config=${props.configurationId}`">打开课表页 <i class="arrow">→</i></NuxtLink>
          </div>
        </section>
      </template>

      <template v-else-if="showVisual">
        <div class="lines">
          <article v-for="(line, li) in lines" :key="li" class="line">
            <header>
              <div><span class="micro">第 {{ li + 1 }} 行</span><strong>{{ line.children.length }} 个组件</strong></div>
              <div class="ops">
                <button type="button" :disabled="li === 0" @click="move(lines, li, -1)">上移</button>
                <button type="button" :disabled="li === lines.length - 1" @click="move(lines, li, 1)">下移</button>
                <button type="button" class="danger" @click="lines.splice(li, 1)">删除行</button>
              </div>
            </header>
            <div class="row"><SwitchToggle v-model="line.isMainLine" label="主要行" hint="主界面的主要内容行" /></div>
            <div class="row"><SwitchToggle v-model="line.isNotificationEnabled" label="启用提醒" /></div>
            <div class="row"><SwitchToggle v-model="line.hideOnRule" label="按规则隐藏" /></div>
            <div class="row">
              <span class="label">岛分离</span>
              <select v-model.number="line.islandSeparationMode">
                <option v-for="mode in ISLAND_SEPARATION_MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
              </select>
            </div>

            <div class="nodes">
              <article v-for="(node, ni) in line.children" :key="ni" class="node">
                <div class="row"><span class="label">组件编号</span><input v-model="node.id" spellcheck="false" placeholder="照抄设备上的组件标识"></div>
                <div class="row"><span class="label">备注名称</span><input v-model="node.name" maxlength="60" placeholder="可选"></div>
                <div class="row"><SwitchToggle v-model="node.hideOnRule" label="按规则隐藏" /></div>
                <div class="row"><span class="label">正文字号</span><input v-model.number="node.fontSize" type="number" min="6" max="96"></div>
                <div class="row"><span class="label">不透明度</span><input v-model.number="node.opacity" type="number" step="0.05" min="0" max="1"></div>
                <div class="row">
                  <SwitchToggle v-model="node.customBackground" label="自定义背景色" />
                  <input
                    v-if="node.customBackground"
                    :value="toColorInput(node.backgroundColor)"
                    type="color"
                    @input="setColor(node, ($event.target as HTMLInputElement).value)"
                  >
                </div>
                <div class="row">
                  <SwitchToggle v-model="node.fixedWidthEnabled" label="固定宽度" />
                  <input v-if="node.fixedWidthEnabled" v-model.number="node.fixedWidth" type="number" min="10" max="2000">
                </div>
                <details v-if="node.hasSettings" class="settings">
                  <summary>组件设置 · {{ settingFields(node).length }} 项</summary>
                  <div v-for="field in settingFields(node)" :key="field.key" class="row">
                    <SwitchToggle
                      v-if="field.kind === 'bool'"
                      :label="field.key"
                      :model-value="boolSetting(node, field.key)"
                      @update:model-value="setSetting(node, field.key, $event)"
                    />
                    <template v-else>
                      <span class="label">{{ field.key }}</span>
                      <input
                        v-if="field.kind === 'number'"
                        type="number"
                        step="any"
                        :value="numberSetting(node, field.key)"
                        @input="setSetting(node, field.key, numberFrom($event))"
                      >
                      <input
                        v-else-if="field.kind === 'color'"
                        type="color"
                        :value="toColorInput(textSetting(node, field.key))"
                        @input="setSetting(node, field.key, fromColorInput(($event.target as HTMLInputElement).value, textSetting(node, field.key)))"
                      >
                      <input
                        v-else
                        type="text"
                        :value="textSetting(node, field.key)"
                        @input="setSetting(node, field.key, ($event.target as HTMLInputElement).value)"
                      >
                    </template>
                  </div>
                  <p v-if="!settingFields(node).length" class="hint">这个组件没有可改的设置。</p>
                </details>
                <div class="ops">
                  <button type="button" :disabled="ni === 0" @click="move(line.children, ni, -1)">上移</button>
                  <button type="button" :disabled="ni === line.children.length - 1" @click="move(line.children, ni, 1)">下移</button>
                  <button type="button" class="danger" @click="line.children.splice(ni, 1)">删除组件</button>
                </div>
              </article>
              <button type="button" class="add" @click="line.children.push(newComponentNode())">添加组件</button>
            </div>
          </article>
          <button type="button" class="add" @click="lines.push(newComponentLine())">添加行</button>
        </div>
        <p class="hint">组件编号要照抄设备上注册的组件标识，写错会显示成空白组件。</p>
      </template>

      <textarea v-else v-model="jsonText" class="json" spellcheck="false" />
    </template>

    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">取消</button>
      <button type="button" :disabled="busy || loading" @click="save">{{ busy ? "保存中…" : "保存为新修订" }}</button>
    </template>
  </AppDialog>
</template><style scoped>
.notice{margin:0 0 20px;padding:12px 16px;border-left:2px solid var(--accent);background:var(--surface-2);color:var(--ink-soft);font-size:11px;line-height:1.7}
.group{margin-bottom:18px;border:1px solid var(--line-soft);background:var(--surface-1)}
.group h3{margin:0;padding:14px 18px;border-bottom:1px solid var(--line-strong);font-size:14px;font-weight:600}
.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:10px 18px;border-bottom:1px solid var(--line-soft);transition:background var(--t-base) var(--ease-enter)}
.row:last-child{border-bottom:0}
.row:hover{background:var(--accent-wash)}
.label{color:var(--ink-soft);font-size:12px}
.row input[type=text],.row input:not([type]),.row select{min-width:190px}
.row input[type=number]{width:120px}
.row input[type=color]{width:56px;min-height:var(--control-h-sm);padding:2px}
.hint{margin:14px 0 0;color:var(--ink-muted);font-size:11px;line-height:1.7}
.link{display:inline-flex;align-items:center;gap:8px;padding-bottom:5px;border-bottom:1px solid var(--line-strong);color:var(--ink-soft);font-size:12px;text-decoration:none;transition:color var(--t-mid) var(--ease-enter),border-color var(--t-mid) var(--ease-enter)}
.link:hover{border-color:var(--accent);color:var(--accent)}
.lines{display:grid;gap:18px}
.line{border:1px solid var(--line-strong);background:var(--surface-1)}
.line > header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line-strong)}
.line > header strong{display:block;margin-top:6px;font-size:15px;font-weight:600}
.line > header .ops{padding:0;border:0;background:transparent}
.nodes{display:grid;gap:1px;background:var(--line-soft)}
.node{background:var(--surface-2)}
.node .row{background:transparent}
.settings{margin:0;border-top:1px solid var(--line-soft)}
.settings summary{cursor:pointer;padding:14px 18px;color:var(--ink-soft);font-size:12px;letter-spacing:.6px;transition:color var(--t-mid) var(--ease-enter)}
.settings summary:hover{color:var(--accent)}
.settings .row{padding-left:34px}
.ops{display:flex;flex-wrap:wrap;gap:10px;padding:12px 18px;border-top:1px solid var(--line-soft);background:var(--surface-1)}
.ops button{min-height:var(--control-h-sm)}
.add{width:100%;min-height:var(--control-h);border-style:dashed;color:var(--ink-muted);background:var(--surface-1)}
.add:hover:not(:disabled){border-style:solid}
.json{width:100%;min-height:460px;padding:16px 18px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font-family:ui-monospace,monospace;font-size:11px;line-height:1.7;resize:vertical}
@media (max-width:700px){.row{flex-direction:column;align-items:stretch;gap:10px}.row input:not([type=color]),.row select{width:100%;min-width:0}}
</style>