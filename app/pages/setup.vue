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
    toast.err(error?.data?.message || "初始化失败，检查输入后重试。");
  } finally { pending.value = false; }
}
</script>

<template>
  <main class="setup-shell">
    <section class="intro">
      <span class="micro">首次启动</span>
      <h1>建立集控台</h1>
      <i class="rule" />
      <p>只做一次。上线到公网前，记得配好 HTTPS 和备份目录。</p>
      <div class="meta"><strong>SQLite WAL</strong><small>单实例，一条命令就能跑</small></div>
    </section>

    <form v-if="status && !status.initialized" @submit.prevent="submit">
      <span class="micro">创建首位管理员</span>
      <label v-if="status?.requiresBootstrapToken">部署引导令牌<input v-model="bootstrapToken" required type="password" autocomplete="off"></label>
      <label>学校名称<input v-model="form.schoolName" minlength="2" maxlength="80" required autocomplete="organization"></label>
      <label>管理员账号<input v-model="form.username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_.-]+" required autocomplete="username"></label>
      <label>管理员密码<input v-model="form.password" minlength="12" maxlength="128" required type="password" autocomplete="new-password"></label>
      <p class="hint">至少 12 位。服务端只保存摘要。</p>
      <button class="solid" :disabled="pending" type="submit">{{ pending ? "正在初始化…" : "完成初始化" }}<span class="arrow">→</span></button>
    </form>

    <section v-else class="complete">
      <span class="micro">已完成初始化</span>
      <h2>已经配置好了</h2>
      <p>首设入口永久关闭。</p>
      <NuxtLink class="solid" to="/">返回登录 <i class="arrow">→</i></NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.setup-shell { min-height: 100vh; display: grid; grid-template-columns: 1.2fr .8fr; background: var(--canvas); }
.intro { display: flex; flex-direction: column; justify-content: center; padding: clamp(36px, 6vw, 90px); border-right: 1px solid var(--line); }
.intro h1 { margin: 28px 0 0; font-size: clamp(38px, 5.4vw, 60px); font-weight: 750; letter-spacing: -1.6px; }
.rule { display: block; height: 2px; width: 100%; max-width: 420px; margin-top: 30px; background: var(--ink); }
.intro p { max-width: 520px; margin: 26px 0 0; color: var(--ink-soft); font-size: 13px; line-height: 1.9; }
.meta { display: grid; gap: 6px; margin-top: 54px; }
.meta small { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
form, .complete { align-self: center; width: min(380px, 100%); margin: 30px auto; }
form .micro, .complete .micro { display: block; margin-bottom: 26px; }
label { display: grid; gap: 8px; margin-bottom: 18px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; }
label input { width: 100%; min-height: var(--control-h); }
.hint { margin: 0 0 6px; color: var(--ink-faint); font-size: 11px; line-height: 1.7; }
button, .complete a { width: 100%; display: flex; align-items: center; justify-content: space-between; margin-top: 12px; text-decoration: none; }
.complete h2 { margin: 0 0 14px; font-size: 28px; font-weight: 600; letter-spacing: -0.8px; }
.complete p { margin: 0 0 22px; color: var(--ink-soft); font-size: 13px; }
@media (max-width: 850px) {
  .setup-shell { grid-template-columns: 1fr; }
  .intro { border-right: 0; border-bottom: 1px solid var(--line); padding: 40px 26px; }
  form, .complete { margin: 32px 26px 44px; width: auto; }
}
</style>