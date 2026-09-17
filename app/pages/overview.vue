<script setup lang="ts">
const { data } = await useFetch("/api/v1/admin/dashboard", {
  default: () => ({
    devices: { total: 0, online: 0, drifted: 0 },
    tasks: { active: 0, failed: 0 },
    policyRevision: 0,
    recent: { tasks: [], audit: [] },
  }),
});

const tiles = computed(() => [
  { label: "受管设备", value: data.value.devices.total, tone: "normal" as const },
  { label: "当前在线", value: data.value.devices.online, tone: "good" as const },
  { label: "策略偏差", value: data.value.devices.drifted, tone: "warning" as const },
  { label: "执行中任务", value: data.value.tasks.active, tone: "normal" as const },
]);
</script>

<template>
  <PageHeading kicker="一眼看全局" title="运行总览">
    <span class="revision"><span>策略版本</span><strong>R{{ data.policyRevision }}</strong></span>
  </PageHeading>

  <section class="metrics" aria-label="关键指标">
    <MetricTile
      v-for="(tile, index) in tiles"
      :key="tile.label"
      :style="{ '--i': index }"
      :label="tile.label"
      :value="tile.value"
      :tone="tile.tone"
    />
  </section>

  <section class="workspace">
    <article class="panel fleet">
      <header class="panel-head">
        <h2>设备群</h2>
        <NuxtLink to="/devices">设备列表 <i class="arrow">→</i></NuxtLink>
      </header>
      <div class="fleet-number">
        <strong>{{ data.devices.online }}</strong><span>/ {{ data.devices.total }} 台在线</span>
      </div>
      <div class="bar" aria-label="在线比例"><i :style="{ width: `${data.devices.total ? data.devices.online / data.devices.total * 100 : 0}%` }" /></div>
      <p v-if="data.devices.total === 0">还没有设备接入。</p>
      <p v-else>掉线的设备会用最后一次生效的配置继续运行。</p>
    </article>
    <article class="panel">
      <header class="panel-head"><h2>能做什么</h2></header>
      <ul class="bounds">
        <li><i class="dot good" /><div><strong>只做公开接口支持的事</strong><span>课表、组件、自动化、提醒</span></div></li>
        <li><i class="dot warning" /><div><strong>被改动会自动纠偏</strong><span>并回报当前的偏差</span></div></li>
        <li><i class="dot" /><div><strong>不碰系统底层</strong><span>不跑任意脚本、不读文件</span></div></li>
      </ul>
    </article>
  </section>

  <section class="panel activity">
    <header class="panel-head">
      <h2>最近发生</h2>
      <NuxtLink to="/tasks">任务 <i class="arrow">→</i></NuxtLink>
    </header>
    <div class="activity-grid">
      <ul class="list">
        <li v-for="entry in data.recent.audit" :key="entry.sequence">
          <div class="row-main"><strong>{{ entry.summary }}</strong><small>{{ entry.action }} · {{ entry.createdAt }}</small></div>
        </li>
        <li v-if="!data.recent.audit.length"><div class="row-main"><small>还没有操作记录</small></div></li>
      </ul>
      <ul class="list">
        <li v-for="task in data.recent.tasks" :key="task.id">
          <div class="row-main"><strong>{{ task.name }}</strong><small>{{ task.state }} · {{ task.capabilityId }}</small></div>
        </li>
        <li v-if="!data.recent.tasks.length"><div class="row-main"><small>还没有任务</small></div></li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.revision { display: grid; justify-items: end; gap: 4px; padding-right: 4px; }
.revision span { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.revision strong { font-size: 26px; font-weight: 600; letter-spacing: -0.6px; font-variant-numeric: tabular-nums; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.workspace { display: grid; grid-template-columns: 1.6fr 1fr; gap: 14px; margin-top: 14px; }
.panel { min-height: 280px; }
.fleet-number { display: flex; align-items: baseline; gap: 12px; margin-top: 46px; }
.fleet-number strong { font-size: 58px; font-weight: 600; letter-spacing: -2px; font-variant-numeric: tabular-nums; }
.fleet-number span { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; }
.bar { height: 10px; margin: 22px 0 20px; background: var(--surface-3); }
.bar i { display: block; height: 100%; background: var(--good); transition: width var(--t-enter) var(--ease-enter); }
.fleet p { max-width: 620px; margin: 0; color: var(--ink-soft); font-size: 13px; line-height: 1.8; }
.bounds { display: grid; gap: 0; margin: 18px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.bounds li { display: flex; align-items: center; gap: 14px; min-height: 72px; padding: 12px 2px; border-bottom: 1px solid var(--line-soft); }
.bounds div { display: grid; gap: 5px; }
.bounds strong { font-size: 14px; font-weight: 600; }
.bounds span { color: var(--ink-muted); font-size: 11px; }
.activity { margin-top: 14px; min-height: 0; }
.activity-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 26px; margin-top: 22px; }
.activity-grid .list { border-top: 0; }
.activity-grid .list li { min-height: 62px; }
@media (max-width: 1100px) {
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .workspace, .activity-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) { .metrics { grid-template-columns: 1fr; } }
</style>