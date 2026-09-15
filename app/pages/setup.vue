<script setup lang="ts">
definePageMeta({ layout: false });
const { data: status, refresh } = await useFetch("/api/v1/setup/status");
const bootstrapToken = ref("");
const form = reactive({ username: "admin", password: "", schoolName: "" });
const toast = useToast();
const pending = ref(false);

async function submit() {
  pending.value = true;
  try {
    await $fetch("/api/v1/setup/initialize", { method: "POST", headers: bootstrapToken.value ? { "x-bootstrap-token": bootstrapToken.value } : undefined, body: form });
    await refresh();
    await navigateTo("/");
  } catch (error: any) {
    toast.err(error?.data?.message || "初始化失败，请检查输入后重试。");
  } finally { pending.value = false; }
}
</script>

<template>
  <main class="setup-shell">
    <section class="intro"><span>FIRST RUN / 首次启动</span><h1>建立学校控制平面</h1><p>初始化只执行一次。请在公网暴露服务前完成管理员创建、HTTPS 和备份目录配置。</p><div><strong>SQLite WAL</strong><small>单实例 / 一条 Node 命令运行</small></div></section>
    <form v-if="status && !status.initialized" @submit.prevent="submit"><span>ADMINISTRATOR SETUP</span><h2>创建首位管理员</h2><label v-if="status?.requiresBootstrapToken">部署引导令牌<input v-model="bootstrapToken" required type="password" autocomplete="off"></label><label>学校名称<input v-model="form.schoolName" minlength="2" maxlength="80" required autocomplete="organization"></label><label>管理员账号<input v-model="form.username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_.-]+" required autocomplete="username"></label><label>管理员密码<input v-model="form.password" minlength="12" maxlength="128" required type="password" autocomplete="new-password"></label><p class="hint">至少 12 位。服务端使用 Argon2id 保存密码摘要。</p><button :disabled="pending" type="submit">{{ pending ? "正在初始化…" : "完成初始化" }} <span>→</span></button></form>
    <section v-else class="complete"><span>INITIALIZED</span><h2>初始化已完成</h2><p>首设入口已关闭。请返回控制平面登录。</p><NuxtLink to="/">返回控制平面 →</NuxtLink></section>
  </main>
</template>

<style scoped>
.setup-shell { min-height: 100vh; display: grid; grid-template-columns: 1.2fr .8fr; gap: 16px; padding: 16px; }.intro, form, .complete { border-radius: var(--radius-lg); }.intro { display: flex; flex-direction: column; justify-content: center; padding: clamp(36px, 7vw, 90px); background: var(--surface-2); }.intro > span, form > span, .complete > span { color: var(--ink-muted); font-size: 9px; letter-spacing: .15em; }.intro h1 { max-width: 760px; margin: 30px 0 18px; font-size: clamp(45px, 8vw, 95px); line-height: .98; letter-spacing: -.065em; }.intro p { max-width: 650px; color: var(--ink-soft); line-height: 1.8; }.intro > div { display: grid; gap: 4px; margin-top: 60px; }.intro > div small { color: var(--ink-muted); }form, .complete { align-self: center; margin: 30px; padding: 36px; background: var(--surface-1); }form h2, .complete h2 { margin: 18px 0 30px; font-size: 29px; }label { display: grid; gap: 8px; margin-top: 18px; color: var(--ink-soft); font-size: 11px; }input { min-height: 51px; padding: 0 16px; border: 0; border-radius: 16px; background: var(--surface-2); color: var(--ink); }.hint { color: var(--ink-muted); font-size: 10px; line-height: 1.6; }button, .complete a { width: 100%; min-height: 52px; display: flex; align-items: center; justify-content: space-between; margin-top: 26px; padding: 0 18px; border: 0; border-radius: 16px; background: var(--ink); color: var(--canvas); text-decoration: none; cursor: pointer; }@media (max-width: 850px) { .setup-shell { grid-template-columns: 1fr; }.intro { min-height: 48vh; }form, .complete { margin: 0; } }
</style>
