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
const tab = ref<"visual" | "json">("visual");
const jsonText = ref("");
const source = ref<Record<string, unknown>>({});
const profile = ref<ProfileSettingsModel | null>(null);
const lines = ref<ComponentLineModel[]>([]);

const kindTitle = computed(() => CONFIG_KIND_LABELS[props.kind] ?? props.kind);
/** 目前只有档案与组件布局有可靠的结构定义，其余类型只能编辑 JSON。 */
const hasVisual = computed(() => props.kind === "profile" || props.kind === "components");
const showVisual = computed(() => hasVisual.value && tab.value === "visual");

function buildModels() {
  profile.value = props.kind === "profile" ? readProfileSettings(source.value) : null;
  lines.value = props.kind === "components" ? readComponentLines(source.value) : [];
}

function currentDocument(): Record<string, unknown> {
  if (props.kind === "profile" && profile.value) return writeProfileSettings(profile.value);
  if (props.kind === "components") return writeComponentLines(source.value, lines.value);
  return source.value;
}

function setTab(next: "visual" | "json") {
  if (next === tab.value) return;
  if (next === "json") jsonText.value = JSON.stringify(currentDocument(), null, 2);
  else if (!applyJson()) return;
  tab.value = next;
}

function applyJson(): boolean {
  try {
    const parsed: unknown = JSON.parse(jsonText.value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      toast.err("配置文档的根必须是 JSON 对象。");
      return false;
    }
    source.value = parsed as Record<string, unknown>;
    buildModels();
    return true;
  } catch {
    toast.err("JSON 解析失败，请检查语法。");
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
    toast.ok(`已保存为 R${result.revision}。`);
    emit("saved", result.revision);
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存失败，请确认结构有效。");
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
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "加载配置文档失败。");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <AppDialog
    :title="`可视化编辑：${props.name}`"
    :kicker="`CONFIGURATION / ${kindTitle} · 当前 R${revision}`"
    width="1080px"
    @close="emit('close')"
  >
    <div v-if="loading" class="muted">正在载入最新修订…</div>
    <template v-else>
      <nav v-if="hasVisual" class="tabs">
        <button type="button" :class="{ active: tab === 'visual' }" @click="setTab('visual')">可视化</button>
        <button type="button" :class="{ active: tab === 'json' }" @click="setTab('json')">高级 JSON</button>
      </nav>
      <p v-else class="notice">
        该类型没有可靠的结构定义（自动化工作流与插件设置由宿主与插件自行解释），只能编辑 JSON。
      </p>

      <template v-if="showVisual && profile">
        <section class="group">
          <h3>档案</h3>
          <div class="row"><span class="label">档案名称</span><input v-model="profile.name" maxlength="80"></div>
        </section>
        <section class="group">
          <h3>叠加课表</h3>
          <div class="row">
            <SwitchToggle v-model="profile.overlayEnabled" label="启用临时层课表" hint="在正常课表之上叠加一层，用于临时调整" />
          </div>
          <div v-if="profile.overlayEnabled" class="row">
            <span class="label">叠加的课表</span>
            <select v-model="profile.overlayClassPlanId">
              <option value="">未选择</option>
              <option v-for="plan in profile.classPlans" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
            </select>
          </div>
        </section>
        <section class="group">
          <h3>临时课表群</h3>
          <div class="row">
            <SwitchToggle v-model="profile.tempGroupEnabled" label="启用临时课表群" hint="按临时课表群切换一整套课表" />
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
            <span class="label">设备启动时使用的课表群</span>
            <select v-model="profile.selectedClassPlanGroupId">
              <option v-for="group in profile.groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </div>
        </section>
        <section class="group">
          <h3>课表内容</h3>
          <p class="hint">科目、时间表与一周课表在课表可视化编辑器里改，保存后回到这里下发。</p>
          <NuxtLink class="link" :to="`/timetable?config=${props.configurationId}`">打开可视化课表编辑器</NuxtLink>
        </section>
      </template>

      <template v-else-if="showVisual">
        <div class="lines">
          <article v-for="(line, li) in lines" :key="li" class="line">
            <header>
              <div><span>LINE {{ li + 1 }}</span><strong>{{ line.children.length }} 个组件</strong></div>
              <div class="ops">
                <button type="button" :disabled="li === 0" @click="move(lines, li, -1)">上移</button>
                <button type="button" :disabled="li === lines.length - 1" @click="move(lines, li, 1)">下移</button>
                <button type="button" class="danger" @click="lines.splice(li, 1)">删除行</button>
              </div>
            </header>
            <div class="row"><SwitchToggle v-model="line.isMainLine" label="主要行" hint="主界面上的主要信息行" /></div>
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
                <div class="row"><span class="label">组件 ID</span><input v-model="node.id" spellcheck="false" placeholder="组件 GUID"></div>
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
                  <summary>组件设置（{{ settingFields(node).length }} 项）</summary>
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
                  <p v-if="!settingFields(node).length" class="hint">该组件没有可表单化的设置项。</p>
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
        <p class="hint">组件 ID 是设备上注册的组件 GUID，这里不做校验；未知 ID 会在设备上显示为空白组件。</p>
      </template>

      <textarea v-else v-model="jsonText" class="json" spellcheck="false" />
    </template>

    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">取消</button>
      <button type="button" :disabled="busy || loading" @click="save">{{ busy ? "保存中…" : "保存为新修订" }}</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.tabs{margin-bottom:14px}
.notice{margin:0 0 14px;padding:12px 16px;border-radius:14px;background:var(--surface-2);color:var(--ink-soft);font-size:11px;line-height:1.6}
.group{margin-bottom:14px;padding:18px 20px;border-radius:var(--radius-md);background:var(--surface-1)}
.group h3{margin:0 0 12px;font-size:12px;color:var(--ink-soft)}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px;border-radius:14px;background:var(--surface-2)}
.row + .row{margin-top:8px}
.label{font-size:12px}
.row input[type=text],.row input:not([type]),.row select{min-height:var(--control-h);padding:0 12px;border:0;border-radius:var(--radius-control);background:var(--surface-1);color:var(--ink);min-width:180px}
.row input[type=number]{width:120px;min-height:var(--control-h);padding:0 12px;border:0;border-radius:var(--radius-control);background:var(--surface-1);color:var(--ink)}
.row input[type=color]{width:56px;min-height:var(--control-h);padding:3px;border:0;border-radius:var(--radius-control);background:var(--surface-1)}
.hint{margin:12px 0 0;color:var(--ink-muted);font-size:10px;line-height:1.6}
.link{display:inline-flex;min-height:var(--control-h);align-items:center;padding:0 16px;border-radius:14px;background:var(--surface-2);color:var(--ink);font-size:12px;text-decoration:none}
.lines{display:grid;gap:12px}
.line{padding:16px;border-radius:var(--radius-md);background:var(--surface-1)}
.line > header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.line > header span{color:var(--ink-muted);font-size:9px;letter-spacing:.12em}
.line > header strong{display:block;margin-top:5px;font-size:14px}
.nodes{display:grid;gap:10px;margin-top:12px}
.node{padding:14px;border-radius:var(--radius-row);background:var(--surface-2)}
.node .row{background:var(--surface-1)}
.settings{margin-top:12px;padding:12px 14px;border-radius:14px;background:var(--surface-1)}
.settings summary{cursor:pointer;color:var(--ink-soft);font-size:11px}
.ops{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.ops button,.add{min-height:36px;padding:0 14px;border:0;border-radius:12px;background:var(--surface-3);color:var(--ink);cursor:pointer;font-size:11px}
.ops button.danger{color:var(--bad)}
.ops button:disabled{opacity:.4;cursor:not-allowed}
.add{width:100%;margin-top:10px;background:var(--surface-2);color:var(--ink-soft)}
.json{width:100%;min-height:460px;padding:16px;border:0;border-radius:var(--radius-row);background:var(--surface-2);color:var(--ink);font-family:ui-monospace,monospace;font-size:11px;line-height:1.6;resize:vertical}
@media (max-width:700px){.row{flex-wrap:wrap}.row input:not([type=color]):not([type=number]),.row select{min-width:0;width:100%}}
</style>