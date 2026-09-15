<script setup lang="ts">
const { data } = await useFetch("/api/v1/admin/dashboard", {
  default: () => ({
    devices: { total: 0, online: 0, drifted: 0 },
    tasks: { active: 0, failed: 0 },
    policyRevision: 0,
    recent: { tasks: [], audit: [] },
  }),
});
</script>

<template>
  <PageHeading kicker="OPERATIONS OVERVIEW / 运行总览" title="运行总览"
    description="设备、策略、配置与任务在同一控制平面闭环；不支持的能力会明确标记，而不是假装成功。">
    <span class="revision"><span>当前策略版本</span><strong>R{{ data.policyRevision }}</strong></span>
  </PageHeading>

  <section class="metrics" aria-label="关键指标">
    <MetricTile label="受管设备" :value="data.devices.total" note="已完成设备身份注册" />
    <MetricTile label="当前在线" :value="data.devices.online" note="最近 45 秒完成轮询" tone="good" />
    <MetricTile label="策略偏差" :value="data.devices.drifted" note="实际状态与期望值不同" tone="warning" />
    <MetricTile label="执行中任务" :value="data.tasks.active" note="包括定时、灰度和重试批次" />
  </section>

  <section class="workspace">
    <article class="panel fleet">
      <header><div><span>FLEET STATUS</span><h2>设备群状态</h2></div><NuxtLink to="/devices">查看设备 →</NuxtLink></header>
      <div class="fleet-grid">
        <div class="fleet-number"><strong>{{ data.devices.online }}</strong><span>/ {{ data.devices.total }} ONLINE</span></div>
        <div class="bar" aria-label="在线比例"><i :style="{ width: `${data.devices.total ? data.devices.online / data.devices.total * 100 : 0}%` }" /></div>
        <p v-if="data.devices.total === 0">尚未接入设备。创建一次性接入码或预配置包，终端会在注册后自动激活。</p>
        <p v-else>在线状态来自自适应 5–30 秒 HTTP 轮询；断线设备保留最后一次已验证策略。</p>
      </div>
    </article>
    <article class="panel safety">
      <header><div><span>SAFETY BOUNDARY</span><h2>能力边界</h2></div></header>
      <ul>
        <li><i class="good" /><div><strong>类型化能力</strong><span>课表、组件、自动化、提醒等均通过公开接口执行</span></div></li>
        <li><i class="warning" /><div><strong>收敛锁</strong><span>宿主没有硬锁 API 的项目会周期纠偏并上报偏差</span></div></li>
        <li><i class="muted" /><div><strong>明确不支持</strong><span>不提供任意脚本、文件浏览或内部服务调用</span></div></li>
      </ul>
    </article>
  </section>

  <section class="panel activity">
    <header><div><span>RECENT ACTIVITY</span><h2>最近活动</h2></div><NuxtLink to="/tasks">查看任务 →</NuxtLink></header>
    <div class="activity-grid">
      <ul class="audit">
        <li v-for="entry in data.recent.audit" :key="entry.sequence"><code>{{ entry.action }}</code><span>{{ entry.summary }}</span><small>{{ entry.createdAt }}</small></li>
        <li v-if="!data.recent.audit.length" class="muted">暂无审计事件。</li>
      </ul>
      <ul class="tasks">
        <li v-for="task in data.recent.tasks" :key="task.id"><strong>{{ task.name }}</strong><span>{{ task.state }} · {{ task.capabilityId }}</span></li>
        <li v-if="!data.recent.tasks.length" class="muted">暂无任务。</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.panel header span { color: var(--ink-muted); font-size: 9px; letter-spacing: .15em; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 14px; }.workspace { display: grid; grid-template-columns: 1.6fr 1fr; gap: 14px; margin-top: 14px; }.panel { min-height: 285px; padding: 24px; border-radius: var(--radius-md); background: var(--surface-1); }.panel header { display: flex; align-items: center; justify-content: space-between; }.panel h2 { margin: 6px 0 0; font-size: 21px; }.panel header a { font-size: 11px; text-decoration: none; }
.fleet-grid { margin-top: 44px; }.fleet-number { display: flex; align-items: baseline; gap: 12px; }.fleet-number strong { font-size: 55px; font-variant-numeric: tabular-nums; }.fleet-number span { color: var(--ink-muted); font-size: 10px; }.bar { height: 12px; margin: 20px 0; overflow: hidden; border-radius: 999px; background: var(--surface-2); }.bar i { display: block; height: 100%; border-radius: inherit; background: var(--good); transition: width 300ms var(--ease-enter); }.fleet-grid p { max-width: 640px; color: var(--ink-soft); font-size: 12px; line-height: 1.8; }
ul { display: grid; gap: 11px; margin: 28px 0 0; padding: 0; list-style: none; }li { display: flex; align-items: center; gap: 13px; padding: 16px; border-radius: var(--radius-row); background: var(--surface-2); }li i { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; background: var(--ink-muted); }li i.good { background: var(--good); }li i.warning { background: var(--warning); }li div { display: grid; gap: 4px; }li strong { font-size: 12px; }li span { color: var(--ink-soft); font-size: 10px; line-height: 1.5; }
.activity { margin-top: 14px; min-height: 0; }.activity-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; margin-top: 20px; }.activity-grid ul { margin: 0; }.activity-grid li { display: grid; gap: 3px; align-items: start; }.activity-grid code { font-size: 10px; color: var(--ink-muted); }.activity-grid small { color: var(--ink-muted); font-size: 9px; }
@media (max-width: 1100px) { .metrics { grid-template-columns: repeat(2, 1fr); }.workspace { grid-template-columns: 1fr; }.activity-grid { grid-template-columns: 1fr; } }
@media (max-width: 700px) { .metrics { grid-template-columns: 1fr 1fr; } }  
.revision { display: grid; gap: 4px; justify-items: end; padding: 12px 16px; border-radius: var(--radius-control); background: var(--surface-1); }
.revision span { color: var(--ink-muted); font-size: 9px; letter-spacing: .12em; }
.revision strong { font-size: 24px; font-variant-numeric: tabular-nums; }
@media (max-width: 460px) { .metrics { grid-template-columns: 1fr; } }
</style>
