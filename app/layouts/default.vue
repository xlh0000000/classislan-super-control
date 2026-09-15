<script setup lang="ts">
import { configKindEntries } from "#shared/configuration-kinds";

const route = useRoute();

const colorMode = useState<"light" | "dark">("theme", () => "light");
// 浏览器地址栏与系统 UI 跟随主题：浅色为白，深色为深蓝黑。
const themeColor = computed(() => (colorMode.value === "dark" ? "#0f1421" : "#ffffff"));
useHead({ meta: [{ name: "theme-color", content: themeColor }] });
// 目标选择是全局状态：整页跳转或刷新后从会话缓存恢复，并在变化时写回。
const { selection, restore, persist } = useTargetSelection();
onMounted(() => {
  restore();
  watch(selection, persist, { deep: true });
});
/** 导航按日常动线分组，减少在一长串入口里找东西。四种配置合并成「配置」分类，配置库不再单独占入口。 */
const navGroups: [string, [string, string, string][]][] = [
  ["下发", [
    ["/", "楼栋", "BUILDING"],
    ["/overview", "概览", "OVERVIEW"],
    ["/policies", "策略", "POLICIES"],
    ["/tasks", "任务", "OPERATIONS"],
    ["/rollcall", "点名", "ROLLCALL"],
  ]],
  ["配置", configKindEntries.map((entry) => [entry.page, entry.nav, entry.code] as [string, string, string])],
  ["设备", [
    ["/devices", "设备", "CLIENTS"],
    ["/organization", "组织", "ORGANIZATION"],
    ["/enrollment", "接入", "ENROLLMENT"],
  ]],
  ["系统", [
    ["/audit", "审计", "AUDIT"],
    ["/users", "用户", "ACCESS"],
    ["/settings", "系统", "SYSTEM"],
  ]],
];

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
    <main>
      <header class="topbar">
        <div><span class="eyebrow">SCHOOL MANAGEMENT NETWORK</span><strong>ClassIsland 集中管理</strong></div>
        <div class="top-actions">
          <button type="button" @click="toggleTheme">{{ colorMode === "dark" ? "浅色" : "深色" }}</button>
          <NuxtLink to="/enrollment">接入设备 <span>↗</span></NuxtLink>
        </div>
      </header>
      <div class="content">
        <Transition name="page" mode="out-in">
          <div :key="route.fullPath" class="page-view"><slot /></div>
        </Transition>
      </div>
    </main>
    <aside class="rail">
      <NuxtLink class="brand" to="/">
        <span>CI</span>
        <div><strong>CLASSISLAND</strong><small>CONTROL / 集控</small></div>
      </NuxtLink>
      <nav aria-label="主导航">
        <template v-for="group in navGroups" :key="group[0]">
          <span class="nav-group">{{ group[0] }}</span>
          <NuxtLink
            v-for="item in group[1]"
            :key="item[0]"
            :to="item[0]"
            :class="{ active: route.path === item[0] }"
          >
            <span>{{ item[1] }}</span><small>{{ item[2] }}</small>
          </NuxtLink>
        </template>
      </nav>
      <div class="rail-foot">
        <span class="status-dot" />
        <div><strong>控制平面可用</strong><small>CONTROL PLANE READY</small></div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) 232px; grid-template-areas: "main rail"; gap: 14px; padding: 14px; }
.rail { grid-area: rail; position: sticky; top: 14px; height: calc(100vh - 28px); overflow: auto; padding: 18px 14px; border-radius: var(--radius-lg); background: var(--surface-1); }
main { grid-area: main; min-width: 0; }
.rail::-webkit-scrollbar { width: 6px; }
.rail::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--surface-2); }
.brand { display: flex; gap: 11px; align-items: center; padding: 2px 6px 18px; text-decoration: none; }
.brand > span { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 13px; background: var(--ink); color: var(--canvas); font-weight: 800; font-size: 13px; }
.brand div, .rail-foot div { display: grid; gap: 2px; }
.brand strong { font-size: 11px; letter-spacing: .07em; }
.brand small, .rail-foot small { font-size: 8px; color: var(--ink-muted); letter-spacing: .1em; }
nav { display: grid; gap: 4px; }
.nav-group { margin: 12px 0 2px; padding: 0 12px; color: var(--ink-muted); font-size: 8px; letter-spacing: .18em; }
.nav-group:first-child { margin-top: 0; }
nav a { display: grid; grid-template-columns: 1fr auto; align-items: center; min-height: 44px; padding: 0 12px; border-radius: var(--radius-control); text-decoration: none; color: var(--ink-soft); transition: background 180ms var(--ease-enter), color 180ms var(--ease-enter), transform 180ms var(--ease-enter); }
nav a:hover { background: var(--surface-2); transform: translateX(3px); }
nav a.active { background: var(--ink); color: var(--canvas); }
nav a span { font-size: 13px; font-weight: 650; }
nav a small { font-size: 8px; letter-spacing: .08em; opacity: .64; }
.rail-foot { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding: 13px 11px; border-radius: var(--radius-row); background: var(--surface-2); }
.rail-foot strong { font-size: 10px; }.status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); }
.topbar { position: sticky; top: 14px; z-index: 10; min-height: 72px; display: flex; align-items: center; justify-content: space-between; padding: 12px 18px 12px 24px; border-radius: var(--radius-lg); background: var(--surface-glass); backdrop-filter: blur(22px); }
.topbar > div:first-child { display: grid; gap: 4px; }.eyebrow { font-size: 8px; color: var(--ink-muted); letter-spacing: .15em; }.topbar strong { font-size: 16px; }
.top-actions { display: flex; gap: 8px; }.top-actions button, .top-actions a { min-height: 44px; display: inline-flex; align-items: center; gap: 18px; padding: 0 16px; border: 0; border-radius: var(--radius-control); background: var(--surface-2); text-decoration: none; cursor: pointer; }
.top-actions a { background: var(--ink); color: var(--canvas); }.content { padding: 20px 2px 24px; }
@media (max-width: 1320px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-areas: "rail" "main"; }
  .rail { position: static; height: auto; display: flex; align-items: center; gap: 14px; padding: 10px 14px; }
  .brand { padding: 0 6px 0 0; }
  nav { display: flex; flex: 1; gap: 4px; overflow-x: auto; }
  .nav-group { display: none; }
  nav a { min-width: 104px; }
  .rail-foot { margin: 0; }
}
@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-areas: "rail" "main"; padding: 10px; gap: 10px; }
  .topbar { top: 10px; }
  .rail-foot { display: none; }
}
@media (max-width: 620px) { .topbar { align-items: flex-start; gap: 12px; } .top-actions button, .top-actions a { padding-inline: 11px; font-size: 11px; } }
</style>