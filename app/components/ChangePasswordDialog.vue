<script setup lang="ts">
const props = withDefaults(defineProps<{ forced?: boolean }>(), { forced: false });
const emit = defineEmits<{ close: [] }>();

const toast = useToast();
const { refresh } = useSession();
const form = reactive({ currentPassword: "", newPassword: "", confirmed: "" });
const pending = ref(false);
const mismatch = computed(() => !!form.confirmed && form.newPassword !== form.confirmed);

async function submit() {
  if (mismatch.value || pending.value) return;
  pending.value = true;
  try {
    await $fetch("/api/v1/auth/password", {
      method: "POST" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
      body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
    });
    await refresh();
    toast.ok("密码已更新。");
    emit("close");
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "修改密码失败。");
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <AppDialog :title="props.forced ? '修改初始密码' : '修改密码'" :kicker="props.forced ? '首次登录' : '账号安全'" width="460px" :close-on-backdrop="!props.forced" @close="emit('close')">
    <form id="password-change" class="form" @submit.prevent="submit">
      <label>当前密码<input v-model="form.currentPassword" type="password" required autocomplete="current-password"></label>
      <label>新密码<input v-model="form.newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
      <label>确认新密码<input v-model="form.confirmed" type="password" required minlength="12" maxlength="128" autocomplete="new-password" :data-invalid="mismatch">
        <small v-if="mismatch" class="invalid">两次输入不一致。</small>
      </label>
    </form>
    <template #footer>
      <button v-if="!props.forced" type="button" class="ghost" @click="emit('close')">取消</button>
      <button type="submit" form="password-change" class="solid" :disabled="pending || mismatch">{{ pending ? "保存中…" : "更新密码" }}</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.form { display: grid; gap: 18px; }
.form label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.form input { width: 100%; }
.form input[data-invalid="true"] { border-color: var(--bad); }
.invalid { color: var(--bad); font-size: 10px; letter-spacing: 0.5px; }
</style>
