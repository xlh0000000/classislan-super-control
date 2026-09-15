<script setup lang="ts">
definePageMeta({ layout: false });
const form = reactive({ username: "", password: "" });
const toast = useToast();
const pending = ref(false);

async function submit() {
  pending.value = true;
  try {
    await $fetch("/api/v1/auth/login", { method: "POST" as const, body: form });
    await navigateTo("/");
  } catch (error: any) { toast.err(error?.data?.message || "登录失败，请稍后重试。"); }
  finally { pending.value = false; }
}
</script>

<template>
  <main class="login-shell"><section class="context"><span>AUTHORIZED ACCESS / 管理入口</span><h1>ClassIsland<br>Control</h1><p>集中管理只对经过身份验证的管理员开放。所有变更、任务和高风险操作都会形成审计记录。</p></section><form @submit.prevent="submit"><span>CONTROL PLANE</span><h2>登录</h2><label>账号<input v-model="form.username" required autocomplete="username" autofocus></label><label>密码<input v-model="form.password" required type="password" autocomplete="current-password"></label><button :disabled="pending">{{ pending ? "正在验证…" : "进入控制平面" }} <span>→</span></button></form></main>
</template>

<style scoped>
.login-shell { min-height: 100vh; display: grid; grid-template-columns: 1.25fr .75fr; gap: 16px; padding: 16px; }.context, form { border-radius: var(--radius-lg); }.context { display: flex; flex-direction: column; justify-content: center; padding: clamp(40px, 8vw, 100px); background: var(--surface-2); }.context > span, form > span { color: var(--ink-muted); font-size: 9px; letter-spacing: .15em; }.context h1 { margin: 28px 0; font-size: clamp(55px, 10vw, 120px); line-height: .86; letter-spacing: -.07em; }.context p { max-width: 620px; color: var(--ink-soft); line-height: 1.8; }form { align-self: center; margin: 34px; padding: 38px; background: var(--surface-1); }form h2 { margin: 18px 0 32px; font-size: 32px; }label { display: grid; gap: 9px; margin-top: 18px; color: var(--ink-soft); font-size: 11px; }input { min-height: 52px; padding: 0 16px; border: 0; border-radius: 16px; color: var(--ink); background: var(--surface-2); }button { width: 100%; min-height: 52px; display: flex; justify-content: space-between; align-items: center; margin-top: 28px; padding: 0 18px; border: 0; border-radius: 16px; background: var(--ink); color: var(--canvas); cursor: pointer; }@media (max-width: 760px) { .login-shell { grid-template-columns: 1fr; }.context { min-height: 43vh; }.context h1 { font-size: 55px; }form { margin: 0; } }
</style>
