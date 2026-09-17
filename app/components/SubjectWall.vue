<script setup lang="ts">
/**
 * 常驻科目选择器：ClassIsland 周视图右侧那面科目墙。
 * 网格里选中哪一格，这里点一下就写进去，不用先弹下拉框；
 * 开着「选完跳下一格」时，选完自动把焦点交到下一节。
 */
import { resolveSubjectShortcut } from "#shared/subject-shortcut";

type WallSubject = { id: string; name: string; initial: string };

const props = defineProps<{ subjects: WallSubject[]; current: string; label: string; ready: boolean }>();
const emit = defineEmits<{ pick: [id: string]; clear: [] }>();
const autoNext = defineModel<boolean>("autoNext", { required: true });

const options = computed<WallSubject[]>(() => [
  { id: "", name: "无", initial: "无" },
  ...props.subjects.map((subject) => ({ ...subject, initial: subject.initial || subject.name.slice(0, 1) })),
]);
const active = ref(0);

function isCurrent(index: number) {
  return (options.value[index]?.id ?? "#") === props.current;
}
function moveCursor(next: number) {
  active.value = next;
}

watch(
  () => props.current,
  () => {
    const index = options.value.findIndex((option) => option.id === props.current);
    if (index >= 0) moveCursor(index);
  },
  { immediate: true },
);

function choose(index: number) {
  const option = options.value[index];
  if (!option || !props.ready) return;
  moveCursor(index);
  if (option.id) emit("pick", option.id);
  else emit("clear");
}

function buttons() {
  return Array.from(document.querySelectorAll<HTMLElement>(".subject-wall button[data-index]"));
}
function move(delta: number) {
  const count = options.value.length;
  moveCursor((active.value + delta + count) % count);
  buttons()[active.value]?.scrollIntoView({ block: "nearest" });
}
function moveRow(delta: number) {
  const list = buttons();
  const first = list[0];
  const columns = first ? Math.max(1, list.filter((button) => Math.abs(button.offsetTop - first.offsetTop) < 2).length) : 1;
  move(delta * columns);
}

function onKeydown(event: KeyboardEvent) {
  const key = event.key;
  if (key === "Delete" || key === "Backspace") { event.preventDefault(); emit("clear"); return; }
  if (key === "Enter" || key === " ") { event.preventDefault(); choose(active.value); return; }
  if (key === "ArrowLeft") { event.preventDefault(); move(-1); return; }
  if (key === "ArrowRight") { event.preventDefault(); move(1); return; }
  if (key === "ArrowUp") { event.preventDefault(); moveRow(-1); return; }
  if (key === "ArrowDown") { event.preventDefault(); moveRow(1); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const hit = resolveSubjectShortcut(props.subjects, key);
  if (!hit) return;
  event.preventDefault();
  choose(hit.clear ? 0 : options.value.findIndex((option) => option.id === hit.id));
}
</script>

<template>
  <aside class="subject-wall" tabindex="-1" aria-label="科目选择器" @keydown="onKeydown">
    <header>
      <span>科目</span>
      <strong>{{ props.ready ? props.label : "先点一个格子" }}</strong>
    </header>
    <div class="wall">
      <button
        v-for="(option, index) in options"
        :key="option.id || 'empty'"
        type="button"
        :data-index="index"
        :data-current="isCurrent(index) ? 'true' : 'false'"
        :data-active="index === active ? 'true' : 'false'"
        :data-empty="option.id ? 'false' : 'true'"
        :disabled="!props.ready"
        :title="option.name"
        @click="choose(index)"
        @mouseenter="moveCursor(index)"
        @focus="moveCursor(index)"
      >
        <em v-if="index < 10">{{ index }}</em>
        {{ option.initial }}
      </button>
    </div>
    <footer>
      <SwitchToggle v-model="autoNext" class="auto-next" label="选完跳下一格" />
      <p>{{ props.ready ? "数字或首字直选 · Delete 清空" : "先点一个格子" }}</p>
    </footer>
  </aside>
</template>

<style scoped>
.subject-wall {
  position: sticky;
  top: 20px;
  display: grid;
  gap: 16px;
  padding: 20px 22px;
  border: 1px solid var(--line);
  background: var(--surface-1);
  outline: none;
}
.subject-wall > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.subject-wall > header span { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.subject-wall > header strong { color: var(--ink); font-size: 13px; font-weight: 600; }
.wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 6px; max-height: min(48vh, 420px); overflow: auto; }
.wall button {
  position: relative;
  min-height: 52px;
  padding: 0;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-size: 17px;
  line-height: 1;
  transition: background var(--t-base) var(--ease-enter), border-color var(--t-base) var(--ease-enter), color var(--t-base) var(--ease-enter);
}
.wall button em { position: absolute; top: 5px; left: 6px; color: var(--ink-faint); font-size: 8px; font-style: normal; }
.wall button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-wash); }
.wall button[data-active="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.wall button[data-current="true"] { border-color: var(--fill); background: var(--fill); color: var(--fill-ink); }
.wall button[data-current="true"] em { color: var(--fill-muted); }
.wall button[data-empty="true"] { color: var(--ink-faint); font-size: 13px; }
.wall button[data-empty="true"][data-current="true"] { color: var(--fill-ink); }
.wall button:disabled { opacity: 0.45; cursor: not-allowed; }
.subject-wall > footer { display: grid; gap: 10px; }
.subject-wall > footer p { margin: 0; color: var(--ink-faint); font-size: 10px; letter-spacing: 0.5px; }
@media (max-width: 1100px) { .subject-wall { position: static; } }
</style>