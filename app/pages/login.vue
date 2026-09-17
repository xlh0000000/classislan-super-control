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
  } catch (error: any) { toast.err(error?.data?.message || "登录失败，稍后再试。"); }
  finally { pending.value = false; }
}
</script>

<template>
  <main class="login-shell">
    <section class="context">
      <span class="micro">管理入口</span>
      <h1>CLASSISLAND</h1>
      <div class="sub">集控台 · CONTROL</div>
      <i class="rule" />
      <p>只有管理员能登录。所有改动都会留记录。</p>
    </section>
    <form @submit.prevent="submit">
      <span class="micro">登录</span>
      <label>账号<input v-model="form.username" required autocomplete="username" autofocus></label>
      <label>密码<input v-model="form.password" required type="password" autocomplete="current-password"></label>
      <button class="solid" :disabled="pending">{{ pending ? "正在验证…" : "进入" }}<span class="arrow">→</span></button>
    </form>
  </main>
</template>

<style scoped>
.login-shell { min-height: 100vh; display: grid; grid-template-columns: 1.2fr .8fr; background: var(--canvas); }
.context { display: flex; flex-direction: column; justify-content: center; padding: clamp(40px, 7vw, 96px); border-right: 1px solid var(--line); }
.context h1 { margin: 30px 0 0; font-size: clamp(40px, 6vw, 62px); font-weight: 750; letter-spacing: 2.4px; line-height: 1.05; }
.sub { margin-top: 10px; font-size: 19px; font-weight: 600; letter-spacing: 0.6px; }
.rule { display: block; height: 2px; width: 100%; max-width: 420px; margin-top: 32px; background: var(--ink); }
.context p { max-width: 480px; margin: 26px 0 0; color: var(--ink-soft); font-size: 13px; line-height: 1.9; }
form { align-self: center; width: min(360px, 100%); margin: 34px auto; }
form .micro { display: block; margin-bottom: 26px; }
label { display: grid; gap: 8px; margin-bottom: 20px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; }
label input { width: 100%; min-height: var(--control-h); }
form button { width: 100%; display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
@media (max-width: 760px) {
  .login-shell { grid-template-columns: 1fr; }
  .context { border-right: 0; border-bottom: 1px solid var(--line); padding: 44px 26px; }
  form { margin: 32px 26px 44px; width: auto; }
}
</style>