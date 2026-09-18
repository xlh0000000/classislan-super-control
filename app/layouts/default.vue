<script setup lang="ts">
// 贡献者：威廉
import { configKindEntries } from "#shared/configuration-kinds";

const route = useRoute();

const colorMode = useState<"light" | "dark">("theme", () => "light");
// 浏览器地址栏与系统 UI 跟随主题：浅色为暖灰白，深色为暖黑。
const themeColor = computed(() => (colorMode.value === "dark" ? "#14150f" : "#e8e5e1"));
useHead({ meta: [{ name: "theme-color", content: themeColor }] });
// 目标选择是全局状态：整页跳转或刷新后从会话缓存恢复，并在变化时写回。
const { selection, restore, persist } = useTargetSelection();
onMounted(() => {
  restore();
  watch(selection, persist, { deep: true });
});

/** 导航按日常动线分组，减少在一长串入口里找东西。 */
const navGroups: [string, [string, string][]][] = [
  ["常用", [
    ["/", "楼栋"],
    ["/overview", "总览"],
    ["/policies", "策略"],
    ["/tasks", "任务"],
    ["/automation", "自动任务"],
    ["/rollcall", "点名"],
  ]],
  ["配置", configKindEntries.map((entry) => [entry.page, entry.nav] as [string, string])],
  ["设备", [
    ["/devices", "设备"],
    ["/organization", "组织"],
    ["/enrollment", "接入"],
  ]],
  ["系统", [
    ["/crashes", "崩溃"],
    ["/audit", "审计"],
    ["/users", "用户"],
    ["/settings", "系统"],
  ]],
];
/** 序号是 RhineLab 排版的刻度感，不承载语义。 */
const navIndex = computed(() => {
  const map = new Map<string, string>();
  let i = 0;
  for (const [, items] of navGroups) for (const [path] of items) map.set(path, String(++i).padStart(2, "0"));
  return map;
});

function toggleTheme() {
  colorMode.value = colorMode.value === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = colorMode.value;
  localStorage.setItem("classisland-control-theme", colorMode.value);
}

onMounted(() => {
  const saved = localStorage.getItem("classisland-control-theme");
  colorMode.value = saved === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = colorMode.value;
});
</script>

<template>
  <div class="shell">
    <aside class="rail">
      <NuxtLink class="brand" to="/">
        <span class="mark">CI</span>
        <div><strong>CLASSISLAND</strong><small>集控台 CONTROL</small></div>
      </NuxtLink>
      <nav aria-label="主导航">
        <template v-for="group in navGroups" :key="group[0]">
          <span class="nav-group">{{ group[0] }}</span>
          <NuxtLink
            v-for="item in group[1]"
            :key="item[0]"
            :to="item[0]"
            class="nav-item"
            :class="{ active: route.path === item[0] }"
          >
            <i class="marker" aria-hidden="true" />
            <span>{{ item[1] }}</span>
            <small>{{ navIndex.get(item[0]) }}</small>
          </NuxtLink>
        </template>
      </nav>
      <div class="rail-foot">
        <button type="button" class="ghost" @click="toggleTheme">
          {{ colorMode === "dark" ? "浅色" : "深色" }}<span class="key" aria-hidden="true">◐</span>
        </button>
        <span class="status"><i class="dot breathe" /><span>运行正常</span></span>
      </div>
    </aside>
    <main>
      <Transition name="page" mode="out-in">
        <div :key="route.fullPath" class="page-view"><slot /></div>
      </Transition>
    </main>
  </div>
</template>

<style scoped>
/* 外壳：RhineLab 没有卡片式外壳，靠一条发丝线区分导航与内容。 */
.shell { min-height: 100vh; display: grid; grid-template-columns: 250px minmax(0, 1fr); background: var(--canvas); }
main { min-width: 0; padding: 34px 44px 76px; }
.rail {
  position: sticky;
  top: 0;
  align-self: start;
  height: 100vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  padding: 32px 22px 24px;
  border-right: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 12px; padding: 0 4px 30px; text-decoration: none; }
.brand .mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  background: var(--fill);
  color: var(--fill-ink);
  font-size: 13px;
  font-weight: 750;
  letter-spacing: 1px;
}
.brand div { display: grid; gap: 3px; }
.brand strong { font-size: 16px; font-weight: 750; letter-spacing: 1.2px; }
.brand small { color: var(--ink-muted); font-size: 9px; letter-spacing: 1.1px; }
nav { display: grid; gap: 1px; }
.nav-group {
  margin: 22px 0 8px;
  color: var(--ink-faint);
  font-size: 9px;
  letter-spacing: 1.4px;
}
.nav-group:first-child { margin-top: 0; }
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 10px 0 14px;
  color: var(--ink-soft);
  font-size: 14px;
  letter-spacing: 0.7px;
  text-decoration: none;
  transition: background var(--t-base) var(--ease-enter), color var(--t-base) var(--ease-enter);
}
.nav-item .marker {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  background: currentColor;
  transform: scaleY(0);
  transform-origin: center;
  transition: transform var(--t-base) var(--ease-enter);
}
.nav-item:hover { background: var(--accent-wash); color: var(--accent); }
.nav-item:hover .marker { transform: scaleY(1); }
.nav-item.active { background: var(--surface-2); color: var(--ink); font-weight: 600; }
.nav-item.active .marker { transform: scaleY(1); }
.nav-item small { margin-left: auto; color: var(--ink-faint); font-size: 9px; letter-spacing: 0.9px; }
.nav-item.active small { color: var(--ink-muted); }
.rail-foot { margin-top: auto; display: grid; gap: 12px; padding-top: 26px; }
.rail-foot .ghost { justify-content: flex-start; padding-left: 0; gap: 6px; }
.rail-foot .key { width: 19px; min-width: 19px; padding: 0; }
.status { display: flex; align-items: center; gap: 9px; color: var(--ink-muted); font-size: 10px; letter-spacing: 0.9px; }
.page-view { display: block; }

@media (max-width: 1100px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  main { padding: 26px 22px 60px; }
  .rail {
    position: static;
    height: auto;
    flex-direction: row;
    align-items: center;
    gap: 18px;
    overflow-x: auto;
    padding: 14px 20px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .brand { padding: 0; }
  .brand div { display: none; }
  .brand .mark { width: 34px; height: 34px; }
  nav { display: flex; flex: 1; gap: 2px; }
  .nav-group { display: none; }
  .nav-item { min-height: 36px; padding: 0 12px; white-space: nowrap; }
  .nav-item .marker { top: auto; bottom: 0; left: 10px; right: 10px; width: auto; height: 2px; transform: scaleX(0); }
  .nav-item:hover .marker, .nav-item.active .marker { transform: scaleX(1); }
  .nav-item small { display: none; }
  .rail-foot { margin: 0 0 0 auto; padding: 0; display: flex; align-items: center; gap: 14px; }
}
@media (max-width: 640px) {
  .status { display: none; }
}
</style>